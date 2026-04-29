import { Test, TestingModule } from '@nestjs/testing'
import { SwapService } from './swap.service'
import { PrismaService } from '../prisma/prisma.service'
import { FLASHNET_SERVICE } from '../flashnet/flashnet.module'
import { Prisma } from '@prisma/client'

// ---------------------------------------------------------------------------
// Helpers / mocks
// ---------------------------------------------------------------------------

const MOCK_BOLT11 = 'lnbc1pvjluezpp5mock'

const makeFlashnetMock = (overrides: Partial<ReturnType<typeof baseFlashnetMock>> = {}) => ({
  ...baseFlashnetMock(),
  ...overrides,
})

function baseFlashnetMock() {
  return {
    createOnrampOrder: jest.fn().mockResolvedValue({
      orderId: 'ord_test_001',
      quoteId: 'q_test_001',
      depositAddress: MOCK_BOLT11,
      amountIn: '1000',
      estimatedOut: '920000',
      feeAmount: '10000',
      roundingFeeAmount: '2162',
      totalFeeAmount: '12162',
      feeBps: 41,
      feeAsset: 'USDB',
      route: ['BTC', 'USDB'],
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      priceLockMode: 'approval_required',
      lockedMinAmountOut: '838945',
      amountMode: 'exact_in',
      lightningReceiveRequestId: 'SparkLightningReceiveRequest:mock-001',
      replayed: false,
    }),
  }
}

function makePrismaMock() {
  const txMock = {
    invoice: { create: jest.fn().mockResolvedValue({}) },
    flashnetOrder: { create: jest.fn().mockResolvedValue({}) },
  }

  return {
    $transaction: jest.fn().mockImplementation(async (cb) => cb(txMock)),
    flashnetOrder: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    invoice: {
      findUnique: jest.fn().mockResolvedValue({ bolt11: MOCK_BOLT11 }),
    },
    _txMock: txMock,
  }
}

// Default params shared across happy-path tests
const BASE_PARAMS = {
  idempotencyKey: 'inv_test_001',
  amountSats: 1000,
  amountMsat: 1_000_000,
  recipientSparkAddress: 'spark1qtest',
  lightningNameId: 'ln-1',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SwapService', () => {
  let service: SwapService
  let flashnetMock: ReturnType<typeof makeFlashnetMock>
  let prismaMock: ReturnType<typeof makePrismaMock>

  beforeEach(async () => {
    flashnetMock = makeFlashnetMock()
    prismaMock = makePrismaMock()

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SwapService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: FLASHNET_SERVICE, useValue: flashnetMock },
      ],
    }).compile()

    service = module.get<SwapService>(SwapService)
  })

  afterEach(() => jest.restoreAllMocks())

  describe('initiateOnramp', () => {
    it('happy path — calls Flashnet, persists Invoice + FlashnetOrder in one tx, returns { bolt11, replayed: false }', async () => {
      const result = await service.initiateOnramp(BASE_PARAMS)

      // Returns the Flashnet BOLT11 and replayed: false
      expect(result).toEqual({ bolt11: MOCK_BOLT11, replayed: false })

      // Flashnet called with correct params and idempotency key
      expect(flashnetMock.createOnrampOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationChain: 'spark',
          destinationAsset: 'USDB',
          recipientAddress: BASE_PARAMS.recipientSparkAddress,
          amount: '1000',
          amountMode: 'exact_in',
          slippageBps: 50,
          refundAddress: BASE_PARAMS.recipientSparkAddress,
        }),
        BASE_PARAMS.idempotencyKey,
      )

      // Transaction ran once
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)

      // Invoice created with idempotencyKey as id and real bolt11
      const txInvoiceCreate = prismaMock._txMock.invoice.create.mock.calls[0][0]
      expect(txInvoiceCreate.data.id).toBe(BASE_PARAMS.idempotencyKey)
      expect(txInvoiceCreate.data.bolt11).toBe(MOCK_BOLT11)
      expect(txInvoiceCreate.data.usernameId).toBe(BASE_PARAMS.lightningNameId)
      expect(txInvoiceCreate.data.receivingCurrency).toBe('USDB')
      expect(txInvoiceCreate.data.destinationSparkAddress).toBe(BASE_PARAMS.recipientSparkAddress)

      // FlashnetOrder created with correct invoiceId
      const txOrderCreate = prismaMock._txMock.flashnetOrder.create.mock.calls[0][0]
      expect(txOrderCreate.data.invoiceId).toBe(BASE_PARAMS.idempotencyKey)
      expect(txOrderCreate.data.orderId).toBe('ord_test_001')
      expect(txOrderCreate.data.status).toBe('PENDING_PAYMENT')
      // "920000" smallest units → 0.92 USDB
      expect(txOrderCreate.data.estimatedOut.equals(new Prisma.Decimal('0.92'))).toBe(true)
      // "10000" → 0.01 USDB
      expect(txOrderCreate.data.feeAmount.equals(new Prisma.Decimal('0.01'))).toBe(true)
      // route stored as JSON string
      expect(txOrderCreate.data.route).toBe('["BTC","USDB"]')
    })

    // -------------------------------------------------------------------------
    // PR5 additions
    // -------------------------------------------------------------------------

    it('asserts all six USDB decimal fields are converted correctly', async () => {
      const result = await service.initiateOnramp({ ...BASE_PARAMS, idempotencyKey: 'inv_amounts' })

      expect(result.bolt11).toBe(MOCK_BOLT11)

      const txOrderCreate = prismaMock._txMock.flashnetOrder.create.mock.calls[0][0]
      const d = txOrderCreate.data

      // estimatedOut: "920000" → 0.92
      expect(d.estimatedOut.equals(new Prisma.Decimal('0.92'))).toBe(true)
      // feeAmount: "10000" → 0.01
      expect(d.feeAmount.equals(new Prisma.Decimal('0.01'))).toBe(true)
      // roundingFeeAmount: "2162" → 0.002162
      expect(d.roundingFeeAmount.equals(new Prisma.Decimal('0.002162'))).toBe(true)
      // totalFeeAmount: "12162" → 0.012162
      expect(d.totalFeeAmount.equals(new Prisma.Decimal('0.012162'))).toBe(true)
      // lockedMinAmountOut: "838945" → 0.838945
      expect(d.lockedMinAmountOut.equals(new Prisma.Decimal('0.838945'))).toBe(true)
      // non-USDB fields pass through unchanged
      expect(d.feeBps).toBe(41)
      expect(d.feeAsset).toBe('USDB')
      expect(d.priceLockMode).toBe('approval_required')
    })

    it('Flashnet error — rethrows and does NOT call prisma.$transaction', async () => {
      const flashnetError = new Error('service_unavailable')
      flashnetMock.createOnrampOrder.mockRejectedValueOnce(flashnetError)

      await expect(
        service.initiateOnramp({ ...BASE_PARAMS, idempotencyKey: 'inv_err' }),
      ).rejects.toThrow('service_unavailable')

      expect(prismaMock.$transaction).not.toHaveBeenCalled()
    })

    it('replayed: true with existing FlashnetOrder — returns stored bolt11 without calling $transaction', async () => {
      flashnetMock.createOnrampOrder.mockResolvedValueOnce({
        ...baseFlashnetMock().createOnrampOrder.mock.results[0]?.value,
        orderId: 'ord_replayed',
        quoteId: 'q_replayed',
        depositAddress: MOCK_BOLT11,
        amountIn: '1000',
        estimatedOut: '920000',
        feeAmount: '10000',
        roundingFeeAmount: '2162',
        totalFeeAmount: '12162',
        feeBps: 41,
        feeAsset: 'USDB',
        route: ['BTC', 'USDB'],
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        priceLockMode: 'approval_required',
        lockedMinAmountOut: '838945',
        amountMode: 'exact_in',
        lightningReceiveRequestId: 'SparkLightningReceiveRequest:mock-replayed',
        replayed: true,
      })

      // Simulate existing FlashnetOrder row in DB
      prismaMock.flashnetOrder.findUnique.mockResolvedValueOnce({ invoiceId: 'inv_replayed' })
      prismaMock.invoice.findUnique.mockResolvedValueOnce({ bolt11: 'lnbc1_stored_bolt11' })

      const result = await service.initiateOnramp({
        ...BASE_PARAMS,
        idempotencyKey: 'inv_replayed',
      })

      // Returns { bolt11: stored, replayed: true }
      expect(result).toEqual({ bolt11: 'lnbc1_stored_bolt11', replayed: true })
      // No new DB write
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
    })

    it('replayed: true with NO existing FlashnetOrder (crash-row scenario) — falls through to persist', async () => {
      flashnetMock.createOnrampOrder.mockResolvedValueOnce({
        orderId: 'ord_crash_recover',
        quoteId: 'q_crash_recover',
        depositAddress: MOCK_BOLT11,
        amountIn: '1000',
        estimatedOut: '920000',
        feeAmount: '10000',
        roundingFeeAmount: '2162',
        totalFeeAmount: '12162',
        feeBps: 41,
        feeAsset: 'USDB',
        route: ['BTC', 'USDB'],
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        priceLockMode: 'approval_required',
        lockedMinAmountOut: '838945',
        amountMode: 'exact_in',
        lightningReceiveRequestId: 'SparkLightningReceiveRequest:mock-crash',
        replayed: true,
      })

      // No existing FlashnetOrder — crash-recovery path
      prismaMock.flashnetOrder.findUnique.mockResolvedValueOnce(null)

      const result = await service.initiateOnramp({
        ...BASE_PARAMS,
        idempotencyKey: 'inv_crash',
      })

      // Should fall through and persist normally
      expect(result.bolt11).toBe(MOCK_BOLT11)
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    })

    it('replayed: true with existing FlashnetOrder but invoice bolt11 is null — falls back to response bolt11', async () => {
      flashnetMock.createOnrampOrder.mockResolvedValueOnce({
        orderId: 'ord_null_bolt11',
        quoteId: 'q_null_bolt11',
        depositAddress: MOCK_BOLT11,
        amountIn: '1000',
        estimatedOut: '920000',
        feeAmount: '10000',
        roundingFeeAmount: '2162',
        totalFeeAmount: '12162',
        feeBps: 41,
        feeAsset: 'USDB',
        route: ['BTC', 'USDB'],
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        priceLockMode: 'approval_required',
        lockedMinAmountOut: '838945',
        amountMode: 'exact_in',
        lightningReceiveRequestId: 'SparkLightningReceiveRequest:mock-null',
        replayed: true,
      })

      prismaMock.flashnetOrder.findUnique.mockResolvedValueOnce({ invoiceId: 'inv_null' })
      // Invoice bolt11 is null — tests the ?. nullish fallback
      prismaMock.invoice.findUnique.mockResolvedValueOnce({ bolt11: null })

      const result = await service.initiateOnramp({
        ...BASE_PARAMS,
        idempotencyKey: 'inv_null',
      })

      expect(result.bolt11).toBe(MOCK_BOLT11)
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
    })
  })
})
