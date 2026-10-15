import { bolt11DescriptionHash } from './bolt11-description-hash'
import { testInvoice } from '../flashnet/lightning-quote-fixtures.test-helper'

describe('bolt11DescriptionHash', () => {
  it('returns the h tag as lowercase hex', () => {
    const hash = 'ab'.repeat(32)
    expect(bolt11DescriptionHash(testInvoice('lnbc10u', undefined, hash))).toBe(
      hash,
    )
  })

  it('returns null for an invoice with a d memo and no h', () => {
    expect(bolt11DescriptionHash(testInvoice())).toBeNull()
  })

  it('returns null for something that is not an invoice', () => {
    expect(bolt11DescriptionHash('lnbc_corrupt')).toBeNull()
  })
})
