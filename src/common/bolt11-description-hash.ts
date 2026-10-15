import { bech32 } from 'bech32'
import { readBolt11Tags } from './bolt11-tags'

const DESCRIPTION_HASH_TAG = 23 // h
const DESCRIPTION_HASH_WORDS = 52 // 32 bytes

/**
 * The BOLT11 description hash (`h`) of `bolt11` as lowercase hex, or `null`
 * when the invoice has none or is malformed. Reads the tags only; it does not
 * verify the signature.
 */
export function bolt11DescriptionHash(bolt11: string): string | null {
  try {
    const { words } = bech32.decode(bolt11, 4096)
    const hash = readBolt11Tags(words).tags.get(DESCRIPTION_HASH_TAG)
    if (hash?.length !== DESCRIPTION_HASH_WORDS) return null
    return Buffer.from(bech32.fromWords(hash)).toString('hex')
  } catch {
    return null
  }
}
