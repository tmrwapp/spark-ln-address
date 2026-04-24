import { Logger } from '@nestjs/common'
import { createHash } from 'crypto'

const logger = new Logger('secp256k1.utils')

export async function loadSecp256k1(): Promise<typeof import('@noble/secp256k1')> {
  // Prevent TypeScript from rewriting import() to require() in CJS output
  const importer = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<typeof import('@noble/secp256k1')>

  return importer('@noble/secp256k1')
}

/**
 * Converts a DER-encoded signature to compact (64-byte) format.
 * Based on standard DER decoding for ECDSA.
 */
export function derToCompact(sigBytes: Buffer): Uint8Array {
  try {
    let offset = 2 // Skip 0x30 and length

    // Read R
    if (sigBytes[offset++] !== 0x02) return sigBytes
    const rLen = sigBytes[offset++]
    const r = sigBytes.subarray(offset, offset + rLen)
    offset += rLen

    // Read S
    if (sigBytes[offset++] !== 0x02) return sigBytes
    const sLen = sigBytes[offset++]
    const s = sigBytes.subarray(offset, offset + sLen)

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
    logger.error(`Error converting DER to compact: ${e.message}`)
    return sigBytes
  }
}

/**
 * Verifies a secp256k1 signature over a message.
 *
 * Tolerances (matching LNURL-Auth existing behaviour):
 * - message: tries raw bytes first, then UTF-8 fallback
 * - signature: DER or compact
 * - pubkey: compressed (33 bytes / 66 hex chars) or uncompressed (65 bytes / 130 hex chars)
 *
 * @param message  Hex string of the message (e.g. k1) or raw bytes as Buffer
 * @param sig      Hex string of the signature (DER or compact)
 * @param key      Hex string of the public key (compressed or uncompressed)
 */
export async function verifySignature(
  message: string | Buffer,
  sig: string,
  key: string,
): Promise<boolean> {
  try {
    // Validate sig is hex
    if (!/^[0-9a-fA-F]+$/.test(sig)) {
      logger.error(`Invalid sig (not hex): ${sig}`)
      return false
    }

    // Validate key format: 66 hex (compressed) or 130 hex (uncompressed)
    if (!/^[0-9a-fA-F]{66}$|^[0-9a-fA-F]{130}$/.test(key)) {
      logger.error(`Invalid key format: ${key}`)
      return false
    }

    // Resolve message bytes
    let messageBytes: Buffer
    if (Buffer.isBuffer(message)) {
      messageBytes = message
    } else {
      // Caller passes a hex string — validate and convert
      if (!/^[0-9a-fA-F]+$/.test(message)) {
        logger.error(`Invalid message (not hex): ${message}`)
        return false
      }
      messageBytes = Buffer.from(message, 'hex')
    }

    const sigBytes = Buffer.from(sig, 'hex')
    const pubKeyBytes = Buffer.from(key, 'hex')

    // Dynamically import the ESM module at runtime without TS downleveling
    const { verify, hashes } = await loadSecp256k1()

    // Set up SHA-256 hash function for @noble/secp256k1 (required for verify)
    if (!hashes.sha256) {
      hashes.sha256 = (m: Uint8Array) => {
        return createHash('sha256').update(m).digest()
      }
    }

    // Normalize signature: convert from DER if needed
    let finalSigBytes: Uint8Array = sigBytes
    if (sigBytes.length > 64 && sigBytes[0] === 0x30) {
      finalSigBytes = derToCompact(sigBytes)
    }

    // Verify the signature using secp256k1
    // We try two paths for the message encoding:
    // 1. Raw bytes (standard path)
    // 2. UTF-8 bytes of the hex string (used by Spark signMessageWithIdentityKey)
    const isRawVerify = verify(finalSigBytes, messageBytes, pubKeyBytes)
    if (isRawVerify) {
      return true
    }

    // UTF-8 fallback only when caller passed a hex string (not a raw Buffer)
    if (!Buffer.isBuffer(message)) {
      const messageUtf8Bytes = Buffer.from(message, 'utf8')
      const isUtf8Verify = verify(finalSigBytes, messageUtf8Bytes, pubKeyBytes)
      if (isUtf8Verify) {
        logger.log(`Signature verified using UTF-8 message encoding for key: ${key}`)
        return true
      }
    }

    return false
  } catch (error) {
    logger.error(`Error verifying signature: ${error}`)
    return false
  }
}
