import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service'
import { createHash } from 'crypto'
import { verifySignature } from './secp256k1.utils'
import type { Request } from 'express'

const DEFAULT_MAX_SKEW_MS = 60000

/**
 * Hard cap on remembered signatures per pubkey. Entries expire after maxSkewMs,
 * so an honest client stays far below it and only a flood reaches it. Requests
 * over the cap are rejected rather than evicting a live entry: dropping one
 * early would silently disable replay protection for the signature it belonged
 * to, which is exactly what an attacker would want.
 */
const REPLAY_CACHE_MAX_PER_PUBKEY = 200

/**
 * Number of pubkey buckets that triggers a full sweep. Buckets are pruned when
 * their pubkey next authenticates, so one that goes quiet lingers empty; the
 * sweep collects those. Entries live at most maxSkewMs, so a sweep almost
 * always clears nearly everything.
 */
const REPLAY_CACHE_SWEEP_THRESHOLD = 10000

/**
 * Methods exempt from replay rejection. Re-sending a read is something clients
 * legitimately do — a retry after a dropped response is the obvious case — and
 * a replayed read returns exactly what a fresh one would, so there is nothing
 * to protect. Listing the exempt methods rather than the protected ones means
 * anything new defaults to protected.
 *
 * The corollary is that signed GET/HEAD handlers must stay free of side
 * effects; one that issues a token or consumes a single-use code would need
 * replay protection and would no longer be safe to exempt here.
 */
const REPLAY_EXEMPT_METHODS = ['GET', 'HEAD']

@Injectable()
export class SparkSignatureGuard implements CanActivate {
  private readonly logger = new Logger(SparkSignatureGuard.name)
  private readonly maxSkewMs: number

  /**
   * Signatures already accepted, bucketed by pubkey: each bucket maps a digest
   * of the auth triple to its expiry. A valid client never repeats one, because
   * the timestamp is part of the signed message.
   *
   * Required by the username endpoints: PATCH /v1/users/me/username is NOT
   * idempotent, so a request captured inside the skew window could otherwise be
   * replayed to spend another unit of the change quota, or to flip the user's
   * active name once the quota is gone.
   *
   * Bucketing per pubkey is what keeps that guarantee under load: a flood can
   * only fill the flooder's own bucket, so no amount of traffic from one key can
   * push another key's signature out of the cache and reopen the replay window.
   *
   * Entries expire relative to the timestamp they carry, so a bucket is scanned
   * in full when pruned; REPLAY_CACHE_MAX_PER_PUBKEY bounds what that costs.
   *
   * This is process-local. PM2 runs a single fork instance today
   * (ecosystem.config.cjs), so it covers every request. Scaling to more than one
   * instance or replica would silently weaken it and the cache would have to move
   * to shared storage.
   */
  private readonly seenSignatures = new Map<string, Map<string, number>>()

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    const raw = configService.get('AUTH_MAX_SKEW_MS')
    if (raw === undefined || raw === null || raw === '') {
      this.maxSkewMs = DEFAULT_MAX_SKEW_MS
      return
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.logger.warn(
        `AUTH_MAX_SKEW_MS="${raw}" is not a positive number — falling back to ${DEFAULT_MAX_SKEW_MS}ms`,
      )
      this.maxSkewMs = DEFAULT_MAX_SKEW_MS
      return
    }
    this.maxSkewMs = parsed
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>()

    // 1. Extract headers (Express lowercases all header names)
    const pubkey = req.headers['x-auth-pubkey'] as string | undefined
    const timestamp = req.headers['x-auth-timestamp'] as string | undefined
    const signature = req.headers['x-auth-signature'] as string | undefined

    if (!pubkey || !timestamp || !signature) {
      throw new UnauthorizedException('Missing auth headers')
    }

    // 2. Timestamp skew check
    const ts = Number(timestamp)
    if (isNaN(ts) || Math.abs(Date.now() - ts) > this.maxSkewMs) {
      throw new UnauthorizedException('Timestamp out of range')
    }

    // 3. Compute body hash
    const method = req.method.toUpperCase()
    let bodyHash = ''
    if (['POST', 'PATCH', 'PUT'].includes(method)) {
      if (req.rawBody && req.rawBody.length > 0) {
        bodyHash = createHash('sha256').update(req.rawBody).digest('hex')
      }
      // If rawBody is not available (PR3 must wire raw-body capture), bodyHash stays ''
      // and the guard will reject signatures that include a real body hash.
    }

    // 4. Build canonical message. Uses req.originalUrl so any query string is
    // signed too — otherwise an attacker could tamper with query params without
    // invalidating the signature. Fields joined with ':' (none of METHOD, URL,
    // timestamp, bodyHash can naturally contain an unambiguous ':' boundary).
    const url = req.originalUrl
    const canonicalMessage = `${method}:${url}:${timestamp}:${bodyHash}`

    // 5. Verify signature over the canonical message (as UTF-8 bytes = Buffer)
    const canonicalBuffer = Buffer.from(canonicalMessage, 'utf8')
    const normalizedPubkey = pubkey.toLowerCase()

    const valid = await verifySignature(
      canonicalBuffer,
      signature,
      normalizedPubkey,
    )
    if (!valid) {
      throw new UnauthorizedException('Invalid signature')
    }

    // 6. Look up user by linkingPubKeyHex
    const lightningName = await this.prisma.lightningName.findFirst({
      where: { linkingPubKeyHex: normalizedPubkey, active: true },
      include: { user: true },
    })

    if (!lightningName) {
      throw new UnauthorizedException('Unknown pubkey')
    }

    // 7. Reject replays of an already-accepted signature, for the methods that
    // can be harmed by one. Runs last so that only traffic from a known account
    // can occupy the cache: a valid signature over a throwaway keypair proves
    // nothing and must not be allowed to fill it.
    if (!REPLAY_EXEMPT_METHODS.includes(method)) {
      this.rejectReplay(normalizedPubkey, timestamp, signature)
    }

    // 8. Attach resolved user to request
    req.user = lightningName.user

    return true
  }

  /**
   * Throws when this exact signature has already been accepted, and otherwise
   * records it for as long as it could still be presented again.
   *
   * `timestamp` arrives as the raw header, which is what the client signed and
   * so what the digest has to cover. Callers must have passed it through the
   * skew check first, which is what makes parsing it here safe.
   */
  private rejectReplay(
    pubkey: string,
    timestamp: string,
    signature: string,
  ): void {
    const now = Date.now()
    const signedAtMs = Number(timestamp)

    if (this.seenSignatures.size > REPLAY_CACHE_SWEEP_THRESHOLD) {
      this.sweepSeenSignatures(now)
    }

    let bucket = this.seenSignatures.get(pubkey)
    if (bucket) {
      this.pruneBucket(bucket, now)
    } else {
      bucket = new Map<string, number>()
      this.seenSignatures.set(pubkey, bucket)
    }

    const key = createHash('sha256')
      .update(`${timestamp}:${signature}`)
      .digest('hex')

    if (bucket.has(key)) {
      this.logger.warn(`Replayed signature rejected for pubkey ${pubkey}`)
      throw new UnauthorizedException('Signature already used')
    }

    // Refusing to remember one more signature would mean not being able to
    // detect its replay, so reject instead. Only this pubkey is affected.
    if (bucket.size >= REPLAY_CACHE_MAX_PER_PUBKEY) {
      this.logger.warn(`Replay cache full for pubkey ${pubkey}`)
      throw new UnauthorizedException('Too many signatures in flight')
    }

    // Expiry is derived from the signed timestamp, not from now. The skew check
    // accepts a signature anywhere in [ts - skew, ts + skew], so anchoring to
    // acceptance time would drop it at `now + skew` while it stayed presentable
    // until `ts + skew` — a client whose clock runs fast opens exactly that gap.
    // Past `ts + skew` the skew check rejects the request on its own, so
    // remembering it any longer adds nothing.
    bucket.set(key, signedAtMs + this.maxSkewMs)
  }

  /**
   * Drops expired entries from one bucket. Expiry follows the signed timestamp
   * rather than insertion time, so entries do not expire in insertion order and
   * the scan cannot stop early. A bucket holds at most
   * REPLAY_CACHE_MAX_PER_PUBKEY entries, which bounds the cost.
   *
   * An entry is kept while `now` is still within its window: at exactly
   * `expiresAt` the skew check would admit the signature, so it has to stay.
   */
  private pruneBucket(bucket: Map<string, number>, now: number): void {
    for (const [key, expiresAt] of bucket) {
      if (expiresAt < now) {
        bucket.delete(key)
      }
    }
  }

  /**
   * Prunes every bucket and drops those left empty.
   */
  private sweepSeenSignatures(now: number): void {
    for (const [pubkey, bucket] of this.seenSignatures) {
      this.pruneBucket(bucket, now)
      if (bucket.size === 0) {
        this.seenSignatures.delete(pubkey)
      }
    }
  }
}
