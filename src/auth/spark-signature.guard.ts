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
 * Hard cap on remembered signatures. Entries expire after maxSkewMs, so this is
 * only reached under a flood; evicting the oldest then is preferable to growing
 * without bound.
 */
const REPLAY_CACHE_MAX_ENTRIES = 10000

@Injectable()
export class SparkSignatureGuard implements CanActivate {
  private readonly logger = new Logger(SparkSignatureGuard.name)
  private readonly maxSkewMs: number

  /**
   * Signatures already accepted, keyed by a digest of the auth triple and mapped
   * to their expiry. A valid client never repeats one, because the timestamp is
   * part of the signed message.
   *
   * Required by the username endpoints: PATCH /v1/users/me/username is NOT
   * idempotent, so a request captured inside the skew window could otherwise be
   * replayed to spend another unit of the change quota, or to flip the user's
   * active name once the quota is gone.
   *
   * A Map preserves insertion order and every entry shares the same lifetime, so
   * the oldest key is always the first to expire and pruning can stop at the
   * first live entry.
   *
   * This is process-local. PM2 runs a single fork instance today
   * (ecosystem.config.cjs), so it covers every request. Scaling to more than one
   * instance or replica would silently weaken it and the cache would have to move
   * to shared storage.
   */
  private readonly seenSignatures = new Map<string, number>()

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

    // 6. Reject replays of an already-accepted signature. Runs after
    // verification so that unverified traffic cannot fill the cache.
    this.rejectReplay(normalizedPubkey, timestamp, signature)

    // 7. Look up user by linkingPubKeyHex
    const lightningName = await this.prisma.lightningName.findFirst({
      where: { linkingPubKeyHex: normalizedPubkey, active: true },
      include: { user: true },
    })

    if (!lightningName) {
      throw new UnauthorizedException('Unknown pubkey')
    }

    // 8. Attach resolved user to request
    req.user = lightningName.user

    return true
  }

  /**
   * Throws when this exact signature has already been accepted, and otherwise
   * records it until it falls outside the skew window.
   */
  private rejectReplay(
    pubkey: string,
    timestamp: string,
    signature: string,
  ): void {
    const now = Date.now()
    this.pruneSeenSignatures(now)

    const key = createHash('sha256')
      .update(`${pubkey}:${timestamp}:${signature}`)
      .digest('hex')

    if (this.seenSignatures.has(key)) {
      this.logger.warn(`Replayed signature rejected for pubkey ${pubkey}`)
      throw new UnauthorizedException('Signature already used')
    }

    // Once the timestamp leaves the skew window the skew check rejects the
    // request on its own, so remembering it any longer adds nothing.
    this.seenSignatures.set(key, now + this.maxSkewMs)

    if (this.seenSignatures.size > REPLAY_CACHE_MAX_ENTRIES) {
      const oldest = this.seenSignatures.keys().next()
      if (!oldest.done) {
        this.seenSignatures.delete(oldest.value)
      }
    }
  }

  /**
   * Drops expired entries. All entries share one lifetime, so insertion order is
   * expiry order and the scan can stop at the first live entry.
   */
  private pruneSeenSignatures(now: number): void {
    for (const [key, expiresAt] of this.seenSignatures) {
      if (expiresAt > now) {
        break
      }
      this.seenSignatures.delete(key)
    }
  }
}
