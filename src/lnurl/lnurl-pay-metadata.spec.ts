import { createHash } from 'node:crypto'
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
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).toBe(
      createHash('sha256').update(Buffer.from(metadata, 'utf8')).digest('hex'),
    )
  })
})
