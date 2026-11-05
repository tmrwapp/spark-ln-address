import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service'
import { normalizeUsername } from '../common/utils'
import { randomBytes } from 'crypto'
import { equivalentPubKeyForms, verifySignature } from './secp256k1.utils'
import { isReservedUsername } from '../common/reserved-usernames'

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

  /**
   * Brand, support and role names cannot be registered (issue 32). Ownership
   * itself is proven by the k1 signature: the name is bound to exactly the key
   * that signed, and the Spark address served for it derives from that key.
   */
  private rejectReservedUsername(username: string): void {
    const extra = this.configService.get<string>('RESERVED_USERNAMES')
    if (isReservedUsername(username, extra)) {
      throw new BadRequestException({
        status: 'ERROR',
        reason: 'Username is reserved',
      })
    }
  }

  /**
   * One active name per key. The activePubKey unique index compares strings,
   * so the same key sent in its other encoding (compressed vs uncompressed)
   * would slip past it and let one key hold several names (issue 32).
   */
  private async rejectKeyWithActiveName(key: string): Promise<void> {
    const forms = await equivalentPubKeyForms(key)
    const holder = await this.prisma.lightningName.findFirst({
      where: { activePubKey: { in: forms } },
      select: { id: true },
    })
    if (holder) {
      throw new BadRequestException({
        status: 'ERROR',
        reason: 'Key already has a username',
      })
    }
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

    // After the signature, so an unauthenticated caller cannot probe the list.
    this.rejectReservedUsername(username)
    await this.rejectKeyWithActiveName(key)

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

    // Create user and bind username. Both in one transaction so a losing race
    // on the username does not leave an orphaned User row behind.
    try {
      await this.prisma.$transaction(async (tx) => {
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
      if ((error as { code?: unknown })?.code === 'P2002') {
        throw new BadRequestException({
          status: 'ERROR',
          reason: 'Username already taken',
        })
      }
      throw error
    }

    // Mark nonce as used
    await this.prisma.authNonce.update({
      where: { k1 },
      data: { usedAt: new Date() },
    })

    return { status: 'OK' }
  }
}
