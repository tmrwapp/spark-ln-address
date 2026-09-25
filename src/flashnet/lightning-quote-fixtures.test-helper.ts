import { createECDH, createPrivateKey, randomBytes, sign } from 'node:crypto'
import { bech32 } from 'bech32'
import { LightningQuoteResponse } from './flashnet.types'

/** Offline, randomly signed fixture. No server or payable invoice is involved. */
export function testInvoice(
  prefix = 'lnbc10u',
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const ec = createECDH('secp256k1')
  ec.generateKeys()
  const publicKey = ec.getPublicKey(undefined, 'uncompressed')
  const privateKey = createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'secp256k1',
      d: ec.getPrivateKey().toString('base64url'),
      x: publicKey.subarray(1, 33).toString('base64url'),
      y: publicKey.subarray(33).toString('base64url'),
    },
  })
  const words = Array.from(
    { length: 7 },
    (_, index) => Math.floor(timestamp / 32 ** (6 - index)) % 32,
  )
  for (const [tag, bytes] of [
    [1, randomBytes(32)],
    [16, randomBytes(32)],
    [13, Buffer.from('Offline test')],
    [19, ec.getPublicKey(undefined, 'compressed')],
  ] as const) {
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
  const signature = sign('sha256', message, {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  })
  const order = BigInt(
    '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
  )
  const scalarS = BigInt(`0x${signature.subarray(32).toString('hex')}`)
  if (scalarS > order / 2n) {
    Buffer.from((order - scalarS).toString(16).padStart(64, '0'), 'hex').copy(
      signature,
      32,
    )
  }
  return bech32.encode(
    prefix,
    [...words, ...bech32.toWords(Buffer.concat([signature, Buffer.from([0])]))],
    4096,
  )
}

export function testQuote(): Omit<LightningQuoteResponse, 'replayed'> {
  return {
    quoteId: 'q_test',
    depositAddress: testInvoice(),
    amountIn: '1000',
    estimatedOut: '900000',
    feeAmount: '1000',
    roundingFeeAmount: '0',
    totalFeeAmount: '1000',
    feeBps: 10,
    feeAsset: 'USDB',
    route: ['BTC', 'USDB'],
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    lightningReceiveRequestId: 'SparkLightningReceiveRequest:test',
  }
}
