import { Injectable, BadRequestException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service'
import { normalizeUsername } from '../common/utils'
import { createHash, randomBytes } from 'crypto'

@Injectable()
export class AuthService {
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

    // TODO: Verify secp256k1 signature
    // For now, accept any signature (implement proper verification later)
    if (!this.verifySignature(k1, sig, key)) {
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

  private verifySignature(k1: string, sig: string, key: string): boolean {
    // TODO: Implement proper secp256k1 signature verification
    // For LNURL-Auth, signature should be over the k1 bytes using the linking key
    // This is a placeholder - real implementation needed
    return sig.length === 128 && key.length === 66 // Rough validation for now
  }
}





