import {
  buildLnurlPayMetadata,
  lnurlPayDescriptionHash,
} from './lnurl-pay-metadata'

describe('LNURL-pay metadata', () => {
  it('serializes text/plain then text/identifier with no whitespace', () => {
    expect(buildLnurlPayMetadata('alice', 'guap.to')).toBe(
      '[["text/plain","alice@guap.to"],["text/identifier","alice@guap.to"]]',
    )
  })

  it('hashes the exact UTF-8 bytes as lowercase hex', () => {
    const metadata = buildLnurlPayMetadata('alice', 'guap.to')
    const hash = lnurlPayDescriptionHash(metadata)

    // Known-answer vector independently verified with OpenSSL
    // (`openssl dgst -sha256` over the exact 68 metadata bytes).
    expect(hash).toBe(
      '27862b5ce035d34cd12395e3a66c6c2530df8a24f601cd2baac7850e723a9ccc',
    )
  })
})
