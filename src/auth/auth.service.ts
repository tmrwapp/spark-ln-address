import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service'
import { normalizeUsername } from '../common/utils'
import { randomBytes } from 'crypto'
import { verifySignature } from './secp256k1.utils'

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async generateAuthChallenge(): Promise<{ k1: string; callback: string }> {
    const k1 = randomBytes(32).toString('hex')
    const publicBaseUrl = this.configService.get<string>('PUBLIC_BASE_URL')
    const callback = `${publicBaseUrl}/v1/auth/lnurl/callback`

    // Store nonce with 5-minute expiration
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000)

    await this.prisma.authNonce.create({
      data: {
        k1,
        expiresAt,
      },
    })

    return { k1, callback }
  }

  async verifyAndBindUsername(
    k1: string,
    sig: string,
    key: string,
    rawUsername: string,
  ): Promise<{ status: 'OK' }> {
    const username = normalizeUsername(rawUsername)

    // Find and validate nonce
    const nonce = await this.prisma.authNonce.findUnique({
      where: { k1 },
    })

    if (!nonce) {
      throw new BadRequestException({ status: 'ERROR', reason: 'Invalid k1' })
    }

    if (nonce.usedAt) {
      throw new BadRequestException({
        status: 'ERROR',
        reason: 'k1 already used',
      })
    }

    if (nonce.expiresAt < new Date()) {
      throw new BadRequestException({ status: 'ERROR', reason: 'k1 expired' })
    }

    // Validate input formats before verifying (preserve existing behaviour)
    if (!/^[0-9a-fA-F]{64}$/.test(k1)) {
      this.logger.error(`Invalid k1: ${k1}`)
      throw new BadRequestException({ status: 'ERROR', reason: 'Invalid k1' })
    }

    if (!/^[0-9a-fA-F]+$/.test(sig)) {
      this.logger.error(`Invalid sig: ${sig}`)
      throw new BadRequestException({
        status: 'ERROR',
        reason: 'Invalid signature',
      })
    }

    if (!/^[0-9a-fA-F]{66}$|^[0-9a-fA-F]{130}$/.test(key)) {
      this.logger.error(`Invalid key: ${key}`)
      throw new BadRequestException({ status: 'ERROR', reason: 'Invalid key' })
    }

    // Verify secp256k1 signature
    if (!(await verifySignature(k1, sig, key))) {
      throw new BadRequestException({
        status: 'ERROR',
        reason: 'Invalid signature',
      })
    }

    // Check if username is available. This deliberately does NOT filter on
    // `active`, so a name retired by a username change stays permanently
    // unavailable to everyone.
    const existing = await this.prisma.lightningName.findUnique({
      where: { username },
    })

    if (existing) {
      throw new BadRequestException({
        status: 'ERROR',
        reason: 'Username already taken',
      })
    }

    // Consume k1, create the user and bind the username in one transaction.
    // The nonce read above only produces friendly error reasons; this
    // conditional update is the real single-use gate. Under concurrency the
    // second request blocks on the row lock, then re-reads usedAt as set and
    // changes zero rows, so exactly one request per k1 can succeed. A failure
    // later in the transaction (a taken name) rolls the consume back, so the
    // wallet may retry the same k1 with another name, as before.
    try {
      await this.prisma.$transaction(async (tx) => {
        const now = new Date()
        const consumed = await tx.authNonce.updateMany({
          where: { k1, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        })
        if (consumed.count !== 1) {
          // Lost the race, or k1 expired since the read above: say which.
          const current = await tx.authNonce.findUnique({ where: { k1 } })
          const expired = !current?.usedAt && current?.expiresAt <= now
          throw new BadRequestException({
            status: 'ERROR',
            reason: expired ? 'k1 expired' : 'k1 already used',
          })
        }

        const user = await tx.user.create({
          data: {},
        })

        await tx.lightningName.create({
          data: {
            username,
            userId: user.id,
            linkingPubKeyHex: key,
            // Mirrors linkingPubKeyHex while active; enforces one active name per
            // pubkey through a unique index. See the username-change migration.
            activePubKey: key,
          },
        })
      })
    } catch (error) {
      // The check above is advisory: two registrations racing on the same name
      // both pass it and one loses at the unique index. Report the loser as a
      // taken username rather than a 500.
      const prismaError = error as {
        code?: unknown
        meta?: { target?: unknown }
      }
      if (prismaError?.code === 'P2002') {
        // The activePubKey index means this key already holds an active
        // name; anything else is the username index.
        const target = String(
          Array.isArray(prismaError.meta?.target)
            ? prismaError.meta.target.join(',')
            : (prismaError.meta?.target ?? ''),
        )
        throw new BadRequestException({
          status: 'ERROR',
          reason: target.includes('activePubKey')
            ? 'Key already has a username'
            : 'Username already taken',
        })
      }
      // Write conflict or deadlock (P2034), or a lock wait that outlived the
      // interactive transaction (P2028), between concurrent registrations.
      // Nothing was committed and k1 is still unused, so the wallet may retry.
      if (prismaError?.code === 'P2034' || prismaError?.code === 'P2028') {
        throw new BadRequestException({
          status: 'ERROR',
          reason: 'Registration conflict, please retry',
        })
      }
      throw error
    }

    return { status: 'OK' }
  }
}
