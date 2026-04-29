import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service'
import { normalizeUsername } from '../common/utils'
import { randomBytes } from 'crypto'
import { verifySignature } from './secp256k1.utils'

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
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
      throw new BadRequestException({ status: 'ERROR', reason: 'k1 already used' })
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
      throw new BadRequestException({ status: 'ERROR', reason: 'Invalid signature' })
    }

    if (!/^[0-9a-fA-F]{66}$|^[0-9a-fA-F]{130}$/.test(key)) {
      this.logger.error(`Invalid key: ${key}`)
      throw new BadRequestException({ status: 'ERROR', reason: 'Invalid key' })
    }

    // Verify secp256k1 signature
    if (!(await verifySignature(k1, sig, key))) {
      throw new BadRequestException({ status: 'ERROR', reason: 'Invalid signature' })
    }

    // Check if username is available
    const existing = await this.prisma.lightningName.findUnique({
      where: { username },
    })

    if (existing) {
      throw new BadRequestException({ status: 'ERROR', reason: 'Username already taken' })
    }

    // Create user and bind username
    const user = await this.prisma.user.create({
      data: {},
    })

    await this.prisma.lightningName.create({
      data: {
        username,
        userId: user.id,
        linkingPubKeyHex: key,
      },
    })

    // Mark nonce as used
    await this.prisma.authNonce.update({
      where: { k1 },
      data: { usedAt: new Date() },
    })

    return { status: 'OK' }
  }
}
