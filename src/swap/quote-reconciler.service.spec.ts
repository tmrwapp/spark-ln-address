import {
  QuoteReconciler,
  SETTLEMENT_GRACE_MS,
} from './quote-reconciler.service'

const snapshot = {
  id: 'ord_paid',
  quoteId: 'q_pending',
  status: 'completed',
  updatedAt: '2026-09-25T10:00:00Z',
  amountOut: '920000',
  error: null,
}

function setup() {
  const prisma = {
    flashnetOrder: { findMany: jest.fn().mockResolvedValue([]) },
  }
  const flashnet = { getQuoteOrder: jest.fn().mockResolvedValue(null) }
  const swaps = { applyWebhookEvent: jest.fn().mockResolvedValue(undefined) }
  const service = new QuoteReconciler(
    prisma as any,
    flashnet as any,
    swaps as any,
    { get: () => undefined } as any,
  )
  return { prisma, flashnet, swaps, service }
}

describe('Quote reconciliation', () => {
  it('treats a null order as awaiting payment, never as failure', async () => {
    const { service, prisma, swaps } = setup()
    prisma.flashnetOrder.findMany.mockResolvedValueOnce([
      { id: 'row', quoteId: 'q_pending', orderId: null },
    ])
    await service.reconcileBatch()
    expect(swaps.applyWebhookEvent).not.toHaveBeenCalled()
  })
  it('recovers a funded quote after restart or a missed webhook', async () => {
    const { service, prisma, swaps, flashnet } = setup()
    prisma.flashnetOrder.findMany.mockResolvedValueOnce([
      { id: 'row', quoteId: 'q_pending', orderId: null },
    ])
    flashnet.getQuoteOrder.mockResolvedValue(snapshot)
    await service.reconcileBatch()
    expect(swaps.applyWebhookEvent).toHaveBeenCalledWith({
      event: 'order.completed',
      timestamp: String(Date.parse(snapshot.updatedAt)),
      data: snapshot,
    })
  })
  it.each([
    { ...snapshot, quoteId: 'q_other' },
    { ...snapshot, id: 'ord_other' },
    { ...snapshot, updatedAt: 'invalid' },
  ])('rejects inconsistent status %j', async (response) => {
    const { service, prisma, swaps, flashnet } = setup()
    prisma.flashnetOrder.findMany.mockResolvedValueOnce([
      { id: 'row', quoteId: 'q_pending', orderId: 'ord_paid' },
    ])
    flashnet.getQuoteOrder.mockResolvedValue(response)
    await service.reconcileBatch()
    expect(swaps.applyWebhookEvent).not.toHaveBeenCalled()
  })
  it('reserves capacity for active and unexpired quotes independently of abandoned quotes', async () => {
    const { service, prisma } = setup()
    await service.reconcileBatch()
    const queries = prisma.flashnetOrder.findMany.mock.calls.map(
      ([query]) => query,
    )
    expect(queries).toHaveLength(3)
    expect(queries[0]).toMatchObject({
      where: { orderId: { not: null } },
      take: 20,
    })
    expect(queries[1]).toMatchObject({
      where: {
        orderId: null,
        invoice: { expiresAt: { gt: expect.any(Date) } },
      },
      take: 20,
    })
    expect(queries[2]).toMatchObject({
      where: {
        orderId: null,
        invoice: { expiresAt: { lte: expect.any(Date) } },
      },
      take: 5,
    })
  })
  it('keeps near-expiry payments prioritized throughout the settlement grace window', async () => {
    const { service, prisma } = setup()
    jest.useFakeTimers().setSystemTime(new Date('2026-09-25T12:00:00Z'))
    try {
      await service.reconcileBatch()
      const recent = prisma.flashnetOrder.findMany.mock.calls[1][0]
      const archived = prisma.flashnetOrder.findMany.mock.calls[2][0]
      const cutoff = new Date(Date.now() - SETTLEMENT_GRACE_MS)
      expect(recent.where.invoice.expiresAt).toEqual({ gt: cutoff })
      expect(archived.where.invoice.expiresAt).toEqual({ lte: cutoff })
      expect(cutoff).toEqual(new Date('2026-09-25T06:00:00Z'))
    } finally {
      jest.useRealTimers()
    }
  })
  it('opens an ops recovery case for a polled hold even without a recovery webhook', async () => {
    const { service, prisma, swaps, flashnet } = setup()
    prisma.flashnetOrder.findMany.mockResolvedValueOnce([
      { id: 'row', quoteId: 'q_pending' },
    ])
    flashnet.getQuoteOrder.mockResolvedValue({
      ...snapshot,
      status: 'processing',
      reviewStatus: 'pending_review',
    })
    await service.reconcileBatch()
    expect(swaps.applyWebhookEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: 'order.recovery_required' }),
    )
  })

  it('retries network failures without discarding the quote or calling submission APIs', async () => {
    const { service, prisma, flashnet, swaps } = setup()
    prisma.flashnetOrder.findMany.mockResolvedValueOnce([
      { id: 'row', quoteId: 'q_pending' },
    ])
    flashnet.getQuoteOrder.mockRejectedValue(new Error('offline'))
    await service.reconcileBatch()
    expect(swaps.applyWebhookEvent).not.toHaveBeenCalled()
  })

  it('logs which payment was deferred and why', async () => {
    const { service, prisma, flashnet } = setup()
    const warn = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined)
    prisma.flashnetOrder.findMany.mockResolvedValueOnce([
      { id: 'row', quoteId: 'q_pending', orderId: 'ord_paid' },
    ])
    flashnet.getQuoteOrder.mockRejectedValue(
      new Error('Quote status unavailable'),
    )
    await service.reconcileBatch()
    expect(warn).toHaveBeenCalledWith(
      '[q_pending] quote reconciliation deferred (order=ord_paid): Quote status unavailable',
    )
  })
})
