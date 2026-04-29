import { Test, TestingModule } from '@nestjs/testing'
import { SwapService } from './swap.service'
import { PrismaService } from '../prisma/prisma.service'
import { FLASHNET_SERVICE } from '../flashnet/flashnet.module'
import { Prisma } from '@prisma/client'
import { FlashnetWebhookPayload } from '../flashnet/flashnet.types'
import { FLASHNET_ORDER_STATUS } from './flashnet-order-status'

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
    flashnetOrder: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    flashnetWebhookEvent: {
      upsert: jest.fn().mockResolvedValue({ id: 'wh-1', processedAt: null }),
      update: jest.fn().mockResolvedValue({}),
    },
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
      expect(txOrderCreate.data.status).toBe(FLASHNET_ORDER_STATUS.PENDING_PAYMENT)
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

  // ---------------------------------------------------------------------------
  // PR6 additions — applyWebhookEvent
  // ---------------------------------------------------------------------------

  describe('applyWebhookEvent', () => {
    const BASE_ORDER = {
      id: 'fo-1',
      invoiceId: 'inv-1',
      orderId: 'ord_test_webhook',
      quoteId: 'q_test_webhook',
      status: FLASHNET_ORDER_STATUS.DELIVERING,
      invoice: { id: 'inv-1', amountMsat: BigInt(1_000_000) },
    }

    const BASE_PAYLOAD: FlashnetWebhookPayload = {
      event: 'order.completed',
      timestamp: '1714000000000',
      data: {
        id: 'ord_test_webhook',
        status: 'completed',
        amountOut: '920000',
        feeAmount: '10000',
        error: { code: null, message: null },
      },
    }

    it('order.completed — updates status to DELIVERED, sets actualOut, marks processedAt', async () => {
      prismaMock._txMock.flashnetWebhookEvent.upsert.mockResolvedValueOnce({
        id: 'wh-1',
        processedAt: null,
      })
      prismaMock._txMock.flashnetOrder.findFirst.mockResolvedValueOnce(BASE_ORDER)

      await service.applyWebhookEvent(BASE_PAYLOAD)

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)

      // FlashnetOrder updated with DELIVERED status and actualOut.
      const updateCall = prismaMock._txMock.flashnetOrder.update.mock.calls[0][0]
      expect(updateCall.data.status).toBe(FLASHNET_ORDER_STATUS.DELIVERED)
      expect(updateCall.data.actualOut.equals(new Prisma.Decimal('0.92'))).toBe(true)

      // Webhook event marked as processed.
      const whUpdate = prismaMock._txMock.flashnetWebhookEvent.update.mock.calls[0][0]
      expect(whUpdate.data.processedAt).toBeInstanceOf(Date)
    })

    it('idempotent — second call with same (orderId, event, timestamp) is a no-op', async () => {
      // Simulate already-processed event (processedAt is set).
      prismaMock._txMock.flashnetWebhookEvent.upsert.mockResolvedValueOnce({
        id: 'wh-1',
        processedAt: new Date('2026-04-22T10:00:00Z'),
      })

      await service.applyWebhookEvent(BASE_PAYLOAD)

      // FlashnetOrder.update must NOT have been called.
      expect(prismaMock._txMock.flashnetOrder.update).not.toHaveBeenCalled()
    })

    it('unknown orderId — logs warning and marks event processed, does not update FlashnetOrder', async () => {
      prismaMock._txMock.flashnetWebhookEvent.upsert.mockResolvedValueOnce({
        id: 'wh-2',
        processedAt: null,
      })
      // No matching FlashnetOrder row.
      prismaMock._txMock.flashnetOrder.findFirst.mockResolvedValueOnce(null)

      await service.applyWebhookEvent({ ...BASE_PAYLOAD, data: { ...BASE_PAYLOAD.data, id: 'ord_unknown' } })

      expect(prismaMock._txMock.flashnetOrder.update).not.toHaveBeenCalled()
      // Webhook event still marked processed to prevent repeated log spam.
      expect(prismaMock._txMock.flashnetWebhookEvent.update).toHaveBeenCalledTimes(1)
    })

    it('stale transition (DELIVERED → FAILED) — does not throw, marks webhook processed, leaves order untouched', async () => {
      // Out-of-order / post-terminal deliveries must not propagate as 5xx; if
      // they did, Flashnet would retry indefinitely. Instead we mark the
      // webhook processed (stops retries) and log a warning.
      prismaMock._txMock.flashnetWebhookEvent.upsert.mockResolvedValueOnce({
        id: 'wh-3',
        processedAt: null,
      })
      prismaMock._txMock.flashnetOrder.findFirst.mockResolvedValueOnce({
        ...BASE_ORDER,
        status: FLASHNET_ORDER_STATUS.DELIVERED,
      })

      const warnSpy = jest.spyOn(service['logger'], 'warn')

      await service.applyWebhookEvent({
        ...BASE_PAYLOAD,
        event: 'order.failed',
        data: { ...BASE_PAYLOAD.data, error: { code: null, message: null } },
      })

      expect(prismaMock._txMock.flashnetOrder.update).not.toHaveBeenCalled()
      expect(prismaMock._txMock.flashnetWebhookEvent.update).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'swap.webhook.stale_or_out_of_order' }),
      )
    })

    it('idempotent redelivery (DELIVERING → DELIVERING) — no order update, marks webhook processed', async () => {
      prismaMock._txMock.flashnetWebhookEvent.upsert.mockResolvedValueOnce({
        id: 'wh-3b',
        processedAt: null,
      })
      prismaMock._txMock.flashnetOrder.findFirst.mockResolvedValueOnce({
        ...BASE_ORDER,
        status: FLASHNET_ORDER_STATUS.DELIVERING,
      })

      await service.applyWebhookEvent({
        ...BASE_PAYLOAD,
        event: 'order.delivering',
        data: { ...BASE_PAYLOAD.data, error: { code: null, message: null } },
      })

      expect(prismaMock._txMock.flashnetOrder.update).not.toHaveBeenCalled()
      expect(prismaMock._txMock.flashnetWebhookEvent.update).toHaveBeenCalledTimes(1)
    })

    it('DELIVERING → FAILED logs refund_case_needed warning', async () => {
      prismaMock._txMock.flashnetWebhookEvent.upsert.mockResolvedValueOnce({
        id: 'wh-4',
        processedAt: null,
      })
      prismaMock._txMock.flashnetOrder.findFirst.mockResolvedValueOnce({
        ...BASE_ORDER,
        status: FLASHNET_ORDER_STATUS.DELIVERING,
      })

      const warnSpy = jest.spyOn(service['logger'], 'warn')

      await service.applyWebhookEvent({ ...BASE_PAYLOAD, event: 'order.failed', data: { ...BASE_PAYLOAD.data, error: { code: null, message: null } } })

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'swap.refund_case_needed' }),
      )
    })

    // -------------------------------------------------------------------------
    // PR6 new tests — fee refresh (replaces removed amount_reconciled tests)
    // -------------------------------------------------------------------------

    it('order.refunding from SWAPPING — advances status to REFUNDING and persists error fields', async () => {
      prismaMock._txMock.flashnetWebhookEvent.upsert.mockResolvedValueOnce({
        id: 'wh-5a',
        processedAt: null,
      })
      prismaMock._txMock.flashnetOrder.findFirst.mockResolvedValueOnce({
        ...BASE_ORDER,
        status: FLASHNET_ORDER_STATUS.SWAPPING,
      })

      await service.applyWebhookEvent({
        event: 'order.refunding',
        timestamp: '1714000001000',
        data: {
          id: 'ord_test_webhook',
          status: 'refunding',
          amountOut: null,
          feeAmount: '10000',
          error: { code: 'slippage_exceeded', message: 'Pool moved past slippage tolerance' },
        },
      })

      const updateCall = prismaMock._txMock.flashnetOrder.update.mock.calls[0][0]
      expect(updateCall.data.status).toBe(FLASHNET_ORDER_STATUS.REFUNDING)
      expect(updateCall.data.errorCode).toBe('slippage_exceeded')
      expect(updateCall.data.errorMessage).toBe('Pool moved past slippage tolerance')
    })

    it('order.completed with null amountOut — does not set actualOut', async () => {
      prismaMock._txMock.flashnetWebhookEvent.upsert.mockResolvedValueOnce({
        id: 'wh-5b',
        processedAt: null,
      })
      prismaMock._txMock.flashnetOrder.findFirst.mockResolvedValueOnce({
        ...BASE_ORDER,
        status: FLASHNET_ORDER_STATUS.DELIVERING,
      })

      await service.applyWebhookEvent({
        event: 'order.completed',
        timestamp: '1714000001500',
        data: {
          id: 'ord_test_webhook',
          status: 'completed',
          amountOut: null,
          feeAmount: '10000',
          error: { code: null, message: null },
        },
      })

      const updateCall = prismaMock._txMock.flashnetOrder.update.mock.calls[0][0]
      expect(updateCall.data.status).toBe(FLASHNET_ORDER_STATUS.DELIVERED)
      expect(updateCall.data.actualOut).toBeUndefined()
    })

    // -------------------------------------------------------------------------
    // PR6 new tests — concern #4: refund_case_needed log payload shape
    // -------------------------------------------------------------------------

    it('DELIVERING → FAILED — refund_case_needed log carries correct orderId, invoiceId, amountSats', async () => {
      const DELIVERING_ORDER = {
        id: 'fo-2',
        invoiceId: 'inv-2',
        orderId: 'ord_deliver_fail',
        quoteId: 'q_deliver_fail',
        status: FLASHNET_ORDER_STATUS.DELIVERING,
        invoice: { id: 'inv-2', amountMsat: BigInt(2_000_000) }, // 2000 sats
      }

      prismaMock._txMock.flashnetWebhookEvent.upsert.mockResolvedValueOnce({
        id: 'wh-7',
        processedAt: null,
      })
      prismaMock._txMock.flashnetOrder.findFirst.mockResolvedValueOnce(DELIVERING_ORDER)

      const warnSpy = jest.spyOn(service['logger'], 'warn')

      await service.applyWebhookEvent({
        event: 'order.failed',
        timestamp: '1714000003000',
        data: {
          id: 'ord_deliver_fail',
          status: 'failed',
          amountOut: null,
          feeAmount: '10000',
          error: { code: null, message: null },
        },
      })

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'swap.refund_case_needed',
          orderId: 'ord_deliver_fail',
          invoiceId: 'inv-2',
          amountSats: 2000, // Math.floor(2_000_000 / 1000)
        }),
      )
    })

    it('DELIVERING → FAILED — refund_case_needed log sets amountSats to null when invoice is absent', async () => {
      const ORDER_NO_INVOICE = {
        id: 'fo-3',
        invoiceId: 'inv-3',
        orderId: 'ord_no_invoice',
        quoteId: 'q_no_invoice',
        status: FLASHNET_ORDER_STATUS.DELIVERING,
        invoice: null, // invoice relation not loaded / null
      }

      prismaMock._txMock.flashnetWebhookEvent.upsert.mockResolvedValueOnce({
        id: 'wh-8',
        processedAt: null,
      })
      prismaMock._txMock.flashnetOrder.findFirst.mockResolvedValueOnce(ORDER_NO_INVOICE)

      const warnSpy = jest.spyOn(service['logger'], 'warn')

      await service.applyWebhookEvent({
        event: 'order.failed',
        timestamp: '1714000004000',
        data: {
          id: 'ord_no_invoice',
          status: 'failed',
          amountOut: null,
          feeAmount: '10000',
          error: { code: null, message: null },
        },
      })

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'swap.refund_case_needed',
          amountSats: null,
        }),
      )
    })

    // -------------------------------------------------------------------------
    // PR6 new tests — order.refunded from REFUNDING
    // -------------------------------------------------------------------------

    it('order.refunded from REFUNDING → updates status to REFUNDED', async () => {
      prismaMock._txMock.flashnetWebhookEvent.upsert.mockResolvedValueOnce({
        id: 'wh-9',
        processedAt: null,
      })
      prismaMock._txMock.flashnetOrder.findFirst.mockResolvedValueOnce({
        ...BASE_ORDER,
        status: FLASHNET_ORDER_STATUS.REFUNDING,
      })

      await service.applyWebhookEvent({
        event: 'order.refunded',
        timestamp: '1714000005000',
        data: {
          id: 'ord_test_webhook',
          status: 'refunded',
          amountOut: null,
          feeAmount: '10000',
          error: { code: 'slippage_exceeded', message: 'Slippage limit exceeded' },
        },
      })

      const updateCall = prismaMock._txMock.flashnetOrder.update.mock.calls[0][0]
      expect(updateCall.data.status).toBe(FLASHNET_ORDER_STATUS.REFUNDED)
      // error fields from data.error are persisted.
      expect(updateCall.data.errorCode).toBe('slippage_exceeded')
      expect(updateCall.data.errorMessage).toBe('Slippage limit exceeded')
    })

    // -------------------------------------------------------------------------
    // PR6 new tests — errorCode / errorMessage persistence (lines 234-235)
    // -------------------------------------------------------------------------

    it('order.failed with both errorCode and errorMessage — persists both fields', async () => {
      prismaMock._txMock.flashnetWebhookEvent.upsert.mockResolvedValueOnce({
        id: 'wh-10',
        processedAt: null,
      })
      prismaMock._txMock.flashnetOrder.findFirst.mockResolvedValueOnce({
        ...BASE_ORDER,
        status: FLASHNET_ORDER_STATUS.DELIVERING,
      })

      await service.applyWebhookEvent({
        event: 'order.failed',
        timestamp: '1714000006000',
        data: {
          id: 'ord_test_webhook',
          status: 'failed',
          amountOut: null,
          feeAmount: '10000',
          error: { code: 'delivery_failed', message: 'Payment delivery failed' },
        },
      })

      const updateCall = prismaMock._txMock.flashnetOrder.update.mock.calls[0][0]
      expect(updateCall.data.errorCode).toBe('delivery_failed')
      expect(updateCall.data.errorMessage).toBe('Payment delivery failed')
    })

    it('order.failed with errorCode but no errorMessage — persists errorCode, omits errorMessage', async () => {
      prismaMock._txMock.flashnetWebhookEvent.upsert.mockResolvedValueOnce({
        id: 'wh-11',
        processedAt: null,
      })
      prismaMock._txMock.flashnetOrder.findFirst.mockResolvedValueOnce({
        ...BASE_ORDER,
        status: FLASHNET_ORDER_STATUS.DELIVERING,
      })

      await service.applyWebhookEvent({
        event: 'order.failed',
        timestamp: '1714000007000',
        data: {
          id: 'ord_test_webhook',
          status: 'failed',
          amountOut: null,
          feeAmount: '10000',
          error: { code: 'target_unmet', message: null },
        },
      })

      const updateCall = prismaMock._txMock.flashnetOrder.update.mock.calls[0][0]
      expect(updateCall.data.errorCode).toBe('target_unmet')
      expect(updateCall.data.errorMessage).toBeUndefined()
    })

    it('order.failed with errorMessage but no errorCode — persists errorMessage, omits errorCode', async () => {
      prismaMock._txMock.flashnetWebhookEvent.upsert.mockResolvedValueOnce({
        id: 'wh-12',
        processedAt: null,
      })
      prismaMock._txMock.flashnetOrder.findFirst.mockResolvedValueOnce({
        ...BASE_ORDER,
        status: FLASHNET_ORDER_STATUS.DELIVERING,
      })

      await service.applyWebhookEvent({
        event: 'order.failed',
        timestamp: '1714000008000',
        data: {
          id: 'ord_test_webhook',
          status: 'failed',
          amountOut: null,
          feeAmount: '10000',
          error: { code: null, message: 'Delivery node unreachable' },
        },
      })

      const updateCall = prismaMock._txMock.flashnetOrder.update.mock.calls[0][0]
      expect(updateCall.data.errorCode).toBeUndefined()
      expect(updateCall.data.errorMessage).toBe('Delivery node unreachable')
    })

    it('order.completed with feeAmount — refreshes feeAmount alongside actualOut and DELIVERED status', async () => {
      prismaMock._txMock.flashnetWebhookEvent.upsert.mockResolvedValueOnce({
        id: 'wh-13',
        processedAt: null,
      })
      prismaMock._txMock.flashnetOrder.findFirst.mockResolvedValueOnce({
        ...BASE_ORDER,
        status: FLASHNET_ORDER_STATUS.DELIVERING,
      })

      await service.applyWebhookEvent({
        event: 'order.completed',
        timestamp: '1714000009000',
        data: {
          id: 'ord_test_webhook',
          status: 'completed',
          amountOut: '915000',
          feeAmount: '10500',
          error: { code: null, message: null },
        },
      })

      const updateCall = prismaMock._txMock.flashnetOrder.update.mock.calls[0][0]
      expect(updateCall.data.status).toBe(FLASHNET_ORDER_STATUS.DELIVERED)
      expect(updateCall.data.actualOut.equals(new Prisma.Decimal('0.915'))).toBe(true)
      expect(updateCall.data.feeAmount.equals(new Prisma.Decimal('0.0105'))).toBe(true)
    })

    it('order.swapping from CONFIRMING — advances status to SWAPPING and refreshes feeAmount', async () => {
      prismaMock._txMock.flashnetWebhookEvent.upsert.mockResolvedValueOnce({
        id: 'wh-14',
        processedAt: null,
      })
      prismaMock._txMock.flashnetOrder.findFirst.mockResolvedValueOnce({
        ...BASE_ORDER,
        status: FLASHNET_ORDER_STATUS.CONFIRMING,
      })

      await service.applyWebhookEvent({
        event: 'order.swapping',
        timestamp: '1714000010000',
        data: {
          id: 'ord_test_webhook',
          status: 'swapping',
          amountOut: null,
          feeAmount: '9500',
          error: { code: null, message: null },
        },
      })

      const updateCall = prismaMock._txMock.flashnetOrder.update.mock.calls[0][0]
      expect(updateCall.data.status).toBe(FLASHNET_ORDER_STATUS.SWAPPING)
      expect(updateCall.data.feeAmount.equals(new Prisma.Decimal('0.0095'))).toBe(true)
    })
  })
})
