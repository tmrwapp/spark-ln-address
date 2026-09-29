import { BadGatewayException } from '@nestjs/common'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { loadSecp256k1 } from '../auth/secp256k1.utils'
import { bech32 } from 'bech32'
import { LightningQuoteResponse } from './flashnet.types'

/** Validate the amount and lifetime before handing an upstream invoice to a payer. */
export async function validateLightningQuote(
  quote: Omit<LightningQuoteResponse, 'replayed'>,
  sats: string,
): Promise<void> {
  try {
    if (
      !quote ||
      typeof quote.quoteId !== 'string' ||
      !quote.quoteId.startsWith('q_') ||
      typeof quote.lightningReceiveRequestId !== 'string' ||
      !quote.lightningReceiveRequestId ||
      quote.amountIn !== sats ||
      quote.flexibleAmount ||
      (quote.amountMode != null && quote.amountMode !== 'exact_in') ||
      quote.feeAsset !== 'USDB' ||
      !Array.isArray(quote.route) ||
      quote.route.some((part) => typeof part !== 'string') ||
      !Number.isInteger(quote.feeBps) ||
      quote.feeBps < 0
    )
      throw new Error()
    for (const amount of [
      quote.estimatedOut,
      quote.feeAmount,
      quote.roundingFeeAmount,
      quote.totalFeeAmount,
    ]) {
      if (typeof amount !== 'string' || !/^\d{1,38}$/.test(amount))
        throw new Error()
    }
    if (
      quote.lockedMinAmountOut != null &&
      !/^\d{1,38}$/.test(quote.lockedMinAmountOut)
    )
      throw new Error()
    const expiry = Date.parse(quote.expiresAt)
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error()
    const { prefix, words } = bech32.decode(quote.depositAddress, 4096)
    const match = /^lnbc(\d+)([munp]?)$/.exec(prefix)
    if (!match || words.length < 111) throw new Error()
    // One BTC is 100 billion msat. Pico-BTC requires exact divisibility by ten.
    const factors: Record<string, bigint> = {
      '': 100_000_000_000n,
      m: 100_000_000n,
      u: 100_000n,
      n: 100n,
      p: 1n,
    }
    const raw = BigInt(match[1]) * factors[match[2]]
    if (match[2] === 'p' && raw % 10n !== 0n) throw new Error()
    const msat = match[2] === 'p' ? raw / 10n : raw
    if (msat !== BigInt(sats) * 1000n) throw new Error()
    const number = (values: number[]) =>
      values.reduce((total, word) => total * 32 + word, 0)
    const timestamp = number(words.slice(0, 7))
    let lifetime = 3600
    const tags = new Map<number, number[]>()
    const end = words.length - 104 // Recoverable signature, 65 bytes.
    for (let offset = 7; offset < end; ) {
      if (offset + 3 > end) throw new Error()
      const tag = words[offset]
      const length = words[offset + 1] * 32 + words[offset + 2]
      if (offset + 3 + length > end) throw new Error()
      if (tags.has(tag) && [1, 6, 13, 16, 19, 23].includes(tag))
        throw new Error()
      tags.set(tag, words.slice(offset + 3, offset + 3 + length))
      if (tag === 6)
        lifetime = number(words.slice(offset + 3, offset + 3 + length)) // x: expiry
      offset += 3 + length
    }
    // BOLT11 requires a payment hash, secret and exactly one description form.
    if (
      tags.get(1)?.length !== 52 ||
      tags.get(16)?.length !== 52 ||
      tags.has(13) === tags.has(23) ||
      (tags.has(23) && tags.get(23).length !== 52)
    )
      throw new Error()
    const signature = Uint8Array.from(bech32.fromWords(words.slice(end)))
    if (signature.length !== 65 || signature[64] > 3) throw new Error()
    // Signing data pads the unsigned 5-bit words to a full byte.
    const unsigned = words.slice(0, end)
    while ((unsigned.length * 5) % 8 !== 0) unsigned.push(0)
    const signingBytes = Buffer.concat([
      Buffer.from(prefix),
      Buffer.from(bech32.fromWords(unsigned)).subarray(
        0,
        Math.ceil((end * 5) / 8),
      ),
    ])
    let pubkey: Uint8Array
    if (tags.has(19)) {
      // BOLT11 requires low-S when an explicit payee key is present.
      const order = BigInt(
        '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
      )
      const scalarS = BigInt(
        `0x${Buffer.from(signature.slice(32, 64)).toString('hex')}`,
      )
      if (scalarS > order / 2n) throw new Error()
      pubkey = Uint8Array.from(bech32.fromWords(tags.get(19)))
      if (pubkey.length !== 33) throw new Error()
    } else {
      const secp = await loadSecp256k1()
      const hash = createHash('sha256').update(signingBytes).digest()
      pubkey = secp.recoverPublicKey(
        Uint8Array.from([signature[64], ...signature.slice(0, 64)]),
        hash,
        { prehash: false },
      )
    }
    // SPKI for secp256k1, accepting a compressed public key.
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from('3036301006072a8648ce3d020106052b8104000a032200', 'hex'),
        Buffer.from(pubkey),
      ]),
      format: 'der',
      type: 'spki',
    })
    if (
      !verify(
        'sha256',
        signingBytes,
        { key, dsaEncoding: 'ieee-p1363' },
        signature.slice(0, 64),
      )
    )
      throw new Error()
    const invoiceExpiry = (timestamp + lifetime) * 1000
    if (!Number.isSafeInteger(invoiceExpiry) || invoiceExpiry <= Date.now())
      throw new Error()
    // Never persist a lifetime beyond the signed invoice's own expiry.
    quote.expiresAt = new Date(Math.min(expiry, invoiceExpiry)).toISOString()
  } catch {
    throw new BadGatewayException('Invalid Lightning quote')
  }
}
