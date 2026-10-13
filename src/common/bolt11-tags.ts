/** BOLT11 data part: a 35-bit timestamp, tagged fields, then the signature. */
export const BOLT11_TIMESTAMP_WORDS = 7
export const BOLT11_SIGNATURE_WORDS = 104 // Recoverable signature, 65 bytes.

// Tags that may appear at most once: p, x, d, s, n, h.
const SINGLE_TAGS = [1, 6, 13, 16, 19, 23]

/**
 * The tagged fields of a decoded BOLT11 data part, keyed by tag, plus the
 * word offset where the signature starts. Throws on a field that overruns
 * the signature or a repeated single-use tag. The one tag reader for every
 * BOLT11 check in this service, so they cannot disagree.
 */
export function readBolt11Tags(words: number[]): {
  tags: Map<number, number[]>
  end: number
} {
  const tags = new Map<number, number[]>()
  const end = words.length - BOLT11_SIGNATURE_WORDS
  for (let offset = BOLT11_TIMESTAMP_WORDS; offset < end; ) {
    if (offset + 3 > end) throw new Error('truncated BOLT11 tag')
    const tag = words[offset]
    const length = words[offset + 1] * 32 + words[offset + 2]
    if (offset + 3 + length > end) throw new Error('BOLT11 tag overruns')
    if (tags.has(tag) && SINGLE_TAGS.includes(tag))
      throw new Error('repeated BOLT11 tag')
    tags.set(tag, words.slice(offset + 3, offset + 3 + length))
    offset += 3 + length
  }
  return { tags, end }
}
