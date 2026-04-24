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

@Injectable()
export class SparkSignatureGuard implements CanActivate {
  private readonly logger = new Logger(SparkSignatureGuard.name)
  private readonly maxSkewMs: number

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

    const valid = await verifySignature(canonicalBuffer, signature, normalizedPubkey)
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

    // 7. Attach resolved user to request
    req.user = lightningName.user

    return true
  }
}
