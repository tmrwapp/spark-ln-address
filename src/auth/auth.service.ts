import { Injectable, BadRequestException, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service'
import { normalizeUsername } from '../common/utils'
import { createHash, randomBytes } from 'crypto'

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

    // Verify secp256k1 signature
    if (!(await this.verifySignature(k1, sig, key))) {
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
        sparkPubKeyHex: key,
      },
    })

    // Mark nonce as used
    await this.prisma.authNonce.update({
      where: { k1 },
      data: { usedAt: new Date() },
    })

    return { status: 'OK' }
  }

  private async verifySignature(k1: string, sig: string, key: string): Promise<boolean> {
    try {
      // Validate input formats
      if (!/^[0-9a-fA-F]{64}$/.test(k1)) {
        this.logger.error(`Invalid k1: ${k1}`)
        return false // k1 must be 64 hex chars (32 bytes)
      }

      if (!/^[0-9a-fA-F]+$/.test(sig)) {
        this.logger.error(`Invalid sig: ${sig}`)
        return false // sig must be hex
      }

      if (!/^[0-9a-fA-F]{66}$|^[0-9a-fA-F]{130}$/.test(key)) {
        this.logger.error(`Invalid key: ${key}`)
        return false // key must be 66 (compressed) or 130 (uncompressed) hex chars
      }

      // Convert k1 from hex to bytes (32 bytes)
      const k1Bytes = Buffer.from(k1, 'hex')
      if (k1Bytes.length !== 32) {
        this.logger.error(`Invalid k1 bytes: ${k1Bytes.length}`)
        return false
      }

      // Convert signature from hex to bytes
      const sigBytes = Buffer.from(sig, 'hex')

      // Convert public key from hex to bytes
      const pubKeyBytes = Buffer.from(key, 'hex')

      // Dynamically import the ESM module at runtime
      const { verify } = await import('@noble/secp256k1')

      // Normalize signature: convert from DER if needed
      let finalSigBytes: Uint8Array = sigBytes
      if (sigBytes.length > 64 && sigBytes[0] === 0x30) {
        finalSigBytes = this.derToCompact(sigBytes)
      }

      // Verify the signature using secp256k1
      // We try two paths for the message encoding:
      // 1. Raw bytes from hex k1 (standard LNURL)
      // 2. UTF-8 bytes of the k1 string (sometimes used by Spark signMessageWithIdentityKey)
      const isRawVerify = verify(finalSigBytes, k1Bytes, pubKeyBytes)
      if (isRawVerify) {
        return true
      }

      const k1Utf8Bytes = Buffer.from(k1, 'utf8')
      const isUtf8Verify = verify(finalSigBytes, k1Utf8Bytes, pubKeyBytes)

      if (isUtf8Verify) {
        this.logger.log(`Signature verified using UTF-8 k1 encoding for key: ${key}`)
        return true
      }

      return false
    } catch (error) {
      // If any error occurs during verification, the signature is invalid
      this.logger.error(`Error verifying signature: ${error}`)
      this.logger.error(`k1: ${k1}`)
      this.logger.error(`sig: ${sig}`)
      this.logger.error(`key: ${key}`)
      return false
    }
  }

  /**
   * Converts a DER-encoded signature to compact (64-byte) format.
   * Based on standard DER decoding for ECDSA.
   */
  private derToCompact(sigBytes: Buffer): Uint8Array {
    try {
      let offset = 2 // Skip 0x30 and length

      // Read R
      if (sigBytes[offset++] !== 0x02) return sigBytes
      let rLen = sigBytes[offset++]
      let r = sigBytes.subarray(offset, offset + rLen)
      offset += rLen

      // Read S
      if (sigBytes[offset++] !== 0x02) return sigBytes
      let sLen = sigBytes[offset++]
      let s = sigBytes.subarray(offset, offset + sLen)

      const normalize = (buf: Uint8Array) => {
        if (buf.length > 32) return buf.slice(buf.length - 32)
        if (buf.length < 32) {
          const res = new Uint8Array(32)
          res.set(buf, 32 - buf.length)
          return res
        }
        return buf
      }

      return Buffer.concat([normalize(r), normalize(s)])
    } catch (e) {
      this.logger.error(`Error converting DER to compact: ${e.message}`)
      return sigBytes
    }
  }
}





