import { Logger } from '@nestjs/common'
import { testInvoice } from '../flashnet/lightning-quote-fixtures.test-helper'

const createLightningInvoice = jest.fn()
jest.mock('@buildonspark/spark-sdk', () => ({
  SparkWallet: {
    initialize: jest
      .fn()
      .mockResolvedValue({ wallet: { createLightningInvoice } }),
  },
}))

import { LightsparkService } from './lightspark.service'

const HASH = 'ab'.repeat(32)
const PUBKEY = '02' + '11'.repeat(32)

describe('LightsparkService.createInvoice', () => {
  let service: LightsparkService
  let errorSpy: jest.SpyInstance

  beforeEach(async () => {
    createLightningInvoice.mockReset()
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation()
    service = new LightsparkService()
    await new Promise((resolve) => setImmediate(resolve)) // wallet init
  })

  afterEach(() => jest.restoreAllMocks())

  it('asks for the description hash and no memo', async () => {
    const bolt11 = testInvoice('lnbc10u', undefined, HASH)
    createLightningInvoice.mockResolvedValue({
      invoice: { encodedInvoice: bolt11 },
    })

    const result = await service.createInvoice(PUBKEY, 1_000_000, HASH)

    expect(createLightningInvoice).toHaveBeenCalledWith({
      receiverIdentityPubkey: PUBKEY,
      amountSats: 1000,
      descriptionHash: HASH,
    })
    expect(result.bolt11).toBe(bolt11)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['a d memo and no h', () => testInvoice()],
    ['a different h', () => testInvoice('lnbc10u', undefined, 'cd'.repeat(32))],
  ])(
    'logs an error, but still returns the invoice, when the SSP returns %s',
    async (_label, makeInvoice) => {
      const bolt11 = makeInvoice()
      createLightningInvoice.mockResolvedValue({
        invoice: { encodedInvoice: bolt11, paymentHash: 'ph-1' },
      })

      const result = await service.createInvoice(PUBKEY, 1_000_000, HASH)

      expect(result.bolt11).toBe(bolt11)
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'lightspark.description_hash_mismatch',
          paymentHash: 'ph-1',
          expectedDescriptionHash: HASH,
          foundDescriptionHash:
            _label === 'a different h' ? 'cd'.repeat(32) : null,
        }),
      )
    },
  )
})
