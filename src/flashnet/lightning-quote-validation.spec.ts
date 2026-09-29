import { bech32 } from 'bech32'
import { validateLightningQuote } from './lightning-quote-validation'
import { testInvoice, testQuote } from './lightning-quote-fixtures.test-helper'

describe('Lightning quote validation', () => {
  it('accepts an exact-in quote without an order or optional price lock', async () => {
    await expect(
      validateLightningQuote(testQuote(), '1000'),
    ).resolves.toBeUndefined()
  })
  it.each(['lnbc', 'lntb10u', 'lnbc11u', 'lnbc10001p'])(
    'rejects wrong network, amountless and mismatched invoices: %s',
    async (prefix) => {
      await expect(
        validateLightningQuote(
          { ...testQuote(), depositAddress: testInvoice(prefix) },
          '1000',
        ),
      ).rejects.toThrow()
    },
  )
  it.each([
    { amountIn: '1001' },
    { flexibleAmount: true },
    { expiresAt: 'invalid' },
    { expiresAt: '2000-01-01T00:00:00Z' },
    { depositAddress: 'lnbc_corrupt' },
    { feeAsset: 'BTC' },
    { estimatedOut: '-1' },
    { lightningReceiveRequestId: '' },
  ])('rejects malformed or incompatible response %j', async (patch) => {
    await expect(
      validateLightningQuote({ ...testQuote(), ...patch }, '1000'),
    ).rejects.toThrow()
  })
  it('rejects missing required tags and an all-zero signature', async () => {
    const timestamp = Math.floor(Date.now() / 1000)
    const words = Array.from(
      { length: 7 },
      (_, index) => Math.floor(timestamp / 32 ** (6 - index)) % 32,
    )
    const invoice = bech32.encode(
      'lnbc10u',
      [...words, ...Array(104).fill(0)],
      4096,
    )
    await expect(
      validateLightningQuote(
        { ...testQuote(), depositAddress: invoice },
        '1000',
      ),
    ).rejects.toThrow()
  })
  it('rejects a tampered signature even with a valid checksum', async () => {
    const quote = testQuote()
    const { prefix, words } = bech32.decode(quote.depositAddress, 4096)
    words[words.length - 20] ^= 1
    quote.depositAddress = bech32.encode(prefix, words, 4096)
    await expect(validateLightningQuote(quote, '1000')).rejects.toThrow()
  })
  it('rejects high-S signatures when an explicit payee is present', async () => {
    const quote = testQuote()
    const { prefix, words } = bech32.decode(quote.depositAddress, 4096)
    const signature = Buffer.from(bech32.fromWords(words.slice(-104)))
    const order = BigInt(
      '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
    )
    const scalarS = BigInt(`0x${signature.subarray(32, 64).toString('hex')}`)
    Buffer.from((order - scalarS).toString(16).padStart(64, '0'), 'hex').copy(
      signature,
      32,
    )
    quote.depositAddress = bech32.encode(
      prefix,
      [...words.slice(0, -104), ...bech32.toWords(signature)],
      4096,
    )
    await expect(validateLightningQuote(quote, '1000')).rejects.toThrow()
  })
  it('rejects an expired invoice even when the quote expiry is in the future', async () => {
    await expect(
      validateLightningQuote(
        { ...testQuote(), depositAddress: testInvoice('lnbc10u', 1) },
        '1000',
      ),
    ).rejects.toThrow()
  })
})
