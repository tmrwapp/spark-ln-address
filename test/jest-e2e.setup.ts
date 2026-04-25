// Set NODE_ENV to test for E2E tests
process.env.NODE_ENV = 'test'

// Force set test database URL - this must override any .env file values
// Prisma reads DATABASE_URL when PrismaClient is instantiated, so we need to set it here
process.env.DATABASE_URL = 'mysql://spark_user:spark_password@localhost:3309/spark_ln_address_test'

// Mock Spark SDK to avoid dynamic import issues (e.g. requiring --experimental-vm-modules)
jest.mock('@buildonspark/spark-sdk', () => {
  const createLightningInvoice = jest.fn().mockResolvedValue({
    invoice: {
      encodedInvoice: 'lnbc1testinvoice',
    },
  })

  return {
    SparkWallet: {
      initialize: jest.fn().mockResolvedValue({
        wallet: {
          createLightningInvoice,
        },
      }),
    },
  }
})

// secp256k1.utils uses `new Function('specifier', 'return import(specifier)')` to load
// @noble/secp256k1 at runtime, bypassing TypeScript's CJS downlevel. This pattern
// triggers ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG inside Jest's VM. Replace with
// a direct (non-dynamic) import so the real verify/sign logic works in e2e tests.
// transformIgnorePatterns in jest-e2e.json already ensures @noble/secp256k1 is
// compiled by ts-jest rather than loaded as raw ESM.
import { createHash } from 'crypto'
import { verify, hashes, sign, getPublicKey } from '@noble/secp256k1'

hashes.sha256 = (m: Uint8Array) => createHash('sha256').update(m).digest()

jest.mock('../src/auth/secp256k1.utils', () => {
  // Inline DER-to-compact conversion (mirrors secp256k1.utils.ts implementation)
  function derToCompact(sigBytes: Buffer): Uint8Array {
    try {
      let offset = 2
      if (sigBytes[offset++] !== 0x02) return sigBytes
      const rLen = sigBytes[offset++]
      const r = sigBytes.subarray(offset, offset + rLen)
      offset += rLen
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
    } catch {
      return sigBytes
    }
  }

  return {
    verifySignature: async (message: string | Buffer, sig: string, key: string): Promise<boolean> => {
      try {
        if (!/^[0-9a-fA-F]+$/.test(sig)) return false
        if (!/^[0-9a-fA-F]{66}$|^[0-9a-fA-F]{130}$/.test(key)) return false
        const messageBytes = Buffer.isBuffer(message) ? message : Buffer.from(message, 'hex')
        const sigBytes = Buffer.from(sig, 'hex')
        const pubKeyBytes = Buffer.from(key, 'hex')
        let finalSig: Uint8Array = sigBytes
        if (sigBytes.length > 64 && sigBytes[0] === 0x30) {
          finalSig = derToCompact(sigBytes)
        }
        return verify(finalSig, messageBytes, pubKeyBytes)
      } catch {
        return false
      }
    },
    loadSecp256k1: async () => ({ verify, hashes, sign, getPublicKey }),
    derToCompact,
  }
})

