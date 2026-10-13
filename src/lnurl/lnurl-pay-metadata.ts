import { createHash } from 'node:crypto'

/**
 * The LNURL-pay `metadata` string (LUD-06, LUD-16) for `username@domain`.
 *
 * The metadata endpoint serves this string and the callback hashes it into
 * the invoice's description hash (BOLT11 `h`). A wallet such as Strike
 * rejects the invoice unless sha256(metadata it received) equals that hash,
 * so both sides must call this one builder: any difference in ordering or
 * whitespace breaks the payment.
 */
export function buildLnurlPayMetadata(
  username: string,
  domain: string,
): string {
  const identifier = `${username}@${domain}`
  return JSON.stringify([
    ['text/plain', identifier],
    ['text/identifier', identifier],
  ])
}

/**
 * Lowercase hex SHA-256 of the exact UTF-8 bytes of `metadata`. If LUD-18
 * `payerData` is ever supported, the hash must cover metadata + payer data.
 */
export function lnurlPayDescriptionHash(metadata: string): string {
  return createHash('sha256').update(metadata, 'utf8').digest('hex')
}
