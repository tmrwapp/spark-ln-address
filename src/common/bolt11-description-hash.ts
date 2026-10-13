import { bech32 } from 'bech32'

const TIMESTAMP_WORDS = 7
const SIGNATURE_WORDS = 104 // Recoverable signature, 65 bytes.
const DESCRIPTION_HASH_TAG = 23 // h
const DESCRIPTION_HASH_WORDS = 52 // 32 bytes

/**
 * The BOLT11 description hash (`h`) of `bolt11` as lowercase hex, or `null`
 * when the invoice has none or cannot be decoded. Reads the tags only; it
 * does not verify the signature.
 */
export function bolt11DescriptionHash(bolt11: string): string | null {
  try {
    const { words } = bech32.decode(bolt11, 4096)
    const end = words.length - SIGNATURE_WORDS
    for (let offset = TIMESTAMP_WORDS; offset + 3 <= end; ) {
      const tag = words[offset]
      const length = words[offset + 1] * 32 + words[offset + 2]
      const data = words.slice(offset + 3, offset + 3 + length)
      if (tag === DESCRIPTION_HASH_TAG && length === DESCRIPTION_HASH_WORDS)
        return Buffer.from(bech32.fromWords(data)).toString('hex')
      offset += 3 + length
    }
    return null
  } catch {
    return null
  }
}
