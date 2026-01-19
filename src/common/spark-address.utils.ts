import { bech32m } from 'bech32'

export type SparkNetwork = 'MAINNET' | 'TESTNET' | 'REGTEST' | 'SIGNET' | 'LOCAL'

const NetworkPrefix: Record<SparkNetwork, string> = {
  MAINNET: 'spark',
  TESTNET: 'sparkt',
  REGTEST: 'sparkrt',
  SIGNET: 'sparks',
  LOCAL: 'sparkl',
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.toLowerCase().replace(/^0x/, '')
  if (clean.length % 2 !== 0) throw new Error('Hex string must have even length.')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = clean.slice(i * 2, i * 2 + 2)
    const n = parseInt(byte, 16)
    if (isNaN(n)) throw new Error(`Invalid hex byte: ${byte}`)
    out[i] = n
  }
  return out
}

/**
 * Encodes a public key hex into a Spark address (Bech32m).
 * Automatically compresses the public key if provided in uncompressed format.
 * @param pubkeyHex Public key hex (33-byte compressed or 65-byte uncompressed)
 * @param network Spark network
 * @returns Bech32m-encoded Spark address
 */
export async function encodeSparkAddress(
  pubkeyHex: string,
  network: SparkNetwork = 'MAINNET',
): Promise<string> {
  let pubkeyBytes = hexToBytes(pubkeyHex)

  // If uncompressed (65 bytes / 130 hex chars), compress it
  if (pubkeyBytes.length === 65) {
    const { Point } = await import('@noble/secp256k1')
    const point = Point.fromHex(pubkeyHex)
    pubkeyBytes = point.toBytes() // true for compressed
  }

  if (pubkeyBytes.length !== 33) {
    throw new Error(`Pubkey must be 33 bytes (compressed) or 65 bytes (uncompressed). Got ${pubkeyBytes.length}.`)
  }

  const first = pubkeyBytes[0]
  if (first !== 0x02 && first !== 0x03) {
    throw new Error(
      `Invalid compressed public key prefix. Expected 02 or 03, got ${first.toString(
        16,
      )}.`,
    )
  }

  const hrp = NetworkPrefix[network]

  // Payload: 0x0A 0x21 <33-byte pubkey>
  const payload = new Uint8Array(2 + pubkeyBytes.length)
  payload[0] = 0x0a
  payload[1] = 0x21
  payload.set(pubkeyBytes, 2)

  const words = bech32m.toWords(payload)
  return bech32m.encode(hrp, words)
}
