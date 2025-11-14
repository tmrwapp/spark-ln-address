import { Injectable, BadRequestException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service'
import { normalizeUsername } from '../common/utils'
import { createHash, randomBytes } from 'crypto'
import { verify } from '@noble/secp256k1'

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
    try {
      // Validate input formats
      if (!/^[0-9a-fA-F]{64}$/.test(k1)) {
        return false // k1 must be 64 hex chars (32 bytes)
      }

      if (!/^[0-9a-fA-F]+$/.test(sig)) {
        return false // sig must be hex
      }

      if (!/^[0-9a-fA-F]{66}$|^[0-9a-fA-F]{130}$/.test(key)) {
        return false // key must be 66 (compressed) or 130 (uncompressed) hex chars
      }

      // Convert k1 from hex to bytes (32 bytes)
      const k1Bytes = Buffer.from(k1, 'hex')
      if (k1Bytes.length !== 32) {
        return false
      }

      // Convert signature from hex to bytes
      const sigBytes = Buffer.from(sig, 'hex')

      // Convert public key from hex to bytes
      const pubKeyBytes = Buffer.from(key, 'hex')

      // Verify the signature using secp256k1
      // The signature is over the k1 bytes (32 bytes)
      // @noble/secp256k1 can handle both DER and compact signature formats
      return verify(sigBytes, k1Bytes, pubKeyBytes)
    } catch (error) {
      // If any error occurs during verification, the signature is invalid
      return false
    }
  }
}





