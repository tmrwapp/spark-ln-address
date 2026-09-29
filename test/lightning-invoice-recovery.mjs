// Offline integration check for the production ESM crypto loader on Node 20.
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { bech32 } from 'bech32'
import { signAsync } from '@noble/secp256k1'

const require = createRequire(import.meta.url)
const {
  validateLightningQuote,
} = require('../dist/flashnet/lightning-quote-validation')
const {
  testQuote,
} = require('../dist/flashnet/lightning-quote-fixtures.test-helper')

test('validates a signed Lightning invoice without an explicit payee tag', async () => {
  const prefix = 'lnbc10u'
  const timestamp = Math.floor(Date.now() / 1000)
  const words = Array.from(
    { length: 7 },
    (_, index) => Math.floor(timestamp / 32 ** (6 - index)) % 32,
  )
  for (const [tag, bytes] of [
    [1, randomBytes(32)],
    [16, randomBytes(32)],
    [13, Buffer.from('Offline test')],
  ]) {
    const values = bech32.toWords(bytes)
    words.push(
      tag,
      Math.floor(values.length / 32),
      values.length % 32,
      ...values,
    )
  }
  const padded = [...words]
  while ((padded.length * 5) % 8 !== 0) padded.push(0)
  const message = Buffer.concat([
    Buffer.from(prefix),
    Buffer.from(bech32.fromWords(padded)).subarray(
      0,
      Math.ceil((words.length * 5) / 8),
    ),
  ])
  const hash = createHash('sha256').update(message).digest()
  const signature = await signAsync(hash, randomBytes(32), {
    prehash: false,
    format: 'recovered',
  })
  const invoice = bech32.encode(
    prefix,
    [
      ...words,
      ...bech32.toWords(
        Buffer.concat([
          Buffer.from(signature.subarray(1)),
          Buffer.from([signature[0]]),
        ]),
      ),
    ],
    4096,
  )
  await validateLightningQuote(
    { ...testQuote(), depositAddress: invoice },
    '1000',
  )
})
