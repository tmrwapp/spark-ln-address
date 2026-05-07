import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import * as request from 'supertest'
import { randomBytes } from 'crypto'
import { AppModule } from './../src/app.module'
import { PrismaService } from '../src/prisma/prisma.service'

const TEST_OPS_TOKEN = 'e2e-ops-secret-do-not-use-in-prod'

// Set env BEFORE the module compiles so ConfigService picks it up. The
// InternalOpsGuard reads INTERNAL_OPS_TOKEN once at construction time and
// caches the result, so post-init mutation has no effect.
process.env.INTERNAL_OPS_TOKEN = TEST_OPS_TOKEN
// Force-empty FLASHNET_API_KEY so the mock factory wins; the mock's
// verifyWebhookSignature returns true, so we don't need to compute a real HMAC.
process.env.FLASHNET_API_KEY = ''

describe('RefundCase webhook integration (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaService

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()

    app = moduleFixture.createNestApplication({ rawBody: true })
    prisma = moduleFixture.get<PrismaService>(PrismaService)
    await app.init()

    // Clean all tables touched by these tests. Order matters for FKs.
    await prisma.refundCase.deleteMany()
    await prisma.flashnetWebhookEvent.deleteMany()
    await prisma.flashnetOrder.deleteMany()
    await prisma.invoice.deleteMany()
    await prisma.lightningName.deleteMany()
    await prisma.user.deleteMany()
  })

  afterEach(async () => {
    await app.close()
  })

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Seeds a User -> LightningName -> Invoice -> FlashnetOrder chain at the
   * given order status. Returns the persisted FlashnetOrder so tests can
   * assert against its id later.
   */
  async function seedOrder(opts: {
    orderId: string
    invoiceId: string
    status: string
    amountMsat?: bigint
  }) {
    const username = `e2e_${randomBytes(4).toString('hex')}`
    const linkingPubKeyHex =
      '02' + randomBytes(32).toString('hex') // 33-byte compressed pubkey
    const user = await prisma.user.create({ data: {} })
    const ln = await prisma.lightningName.create({
      data: {
        username,
        userId: user.id,
        linkingPubKeyHex,
      },
    })
    const invoice = await prisma.invoice.create({
      data: {
        id: opts.invoiceId,
        usernameId: ln.id,
        amountMsat: opts.amountMsat ?? BigInt(2_000_000), // 2000 sats
        bolt11: 'lnbc1e2etest',
        expiresAt: new Date(Date.now() + 24 * 3600_000),
        receivingCurrency: 'USDB',
      },
    })
    const order = await prisma.flashnetOrder.create({
      data: {
        invoiceId: invoice.id,
        orderId: opts.orderId,
        status: opts.status,
      },
    })
    return order
  }

  function buildPayload(opts: {
    orderId: string
    event: string
    error?: { code: string | null; message: string | null }
    amountOut?: string | null
  }) {
    return {
      event: opts.event,
      timestamp: '1714000000000', // body timestamp; controller overwrites with header
      data: {
        id: opts.orderId,
        status: opts.event.replace('order.', ''),
        amountOut: opts.amountOut ?? null,
        feeAmount: '10000',
        error: opts.error ?? { code: null, message: null },
      },
    }
  }

  /**
   * POSTs a webhook to the controller. Uses synthetic header values; with
   * FlashnetMockService active, HMAC verification short-circuits to true.
   */
  function postWebhook(payload: object, timestamp = String(Date.now())) {
    return request(app.getHttpServer())
      .post('/v1/internal/flashnet/webhook')
      .set('X-Flashnet-Signature', 'mock-signature')
      .set('X-Flashnet-Timestamp', timestamp)
      .send(payload)
  }

  // ---------------------------------------------------------------------------
  // Webhook → RefundCase wiring
  // ---------------------------------------------------------------------------

  it('DELIVERING → FAILED: opens a RefundCase atomically with the order update', async () => {
    const orderId = 'ord_e2e_deliver_fail'
    const invoiceId = 'inv_e2e_deliver_fail'
    await seedOrder({ orderId, invoiceId, status: 'DELIVERING' })

    await postWebhook(
      buildPayload({
        orderId,
        event: 'order.failed',
        error: { code: 'delivery_aborted', message: 'destination unreachable' },
      }),
      '1714000001000',
    ).expect(204)

    const order = await prisma.flashnetOrder.findFirst({ where: { orderId } })
    expect(order!.status).toBe('FAILED')

    const refundCases = await prisma.refundCase.findMany({ where: { invoiceId } })
    expect(refundCases).toHaveLength(1)
    expect(refundCases[0]).toMatchObject({
      invoiceId,
      amountSats: 2000,
      status: 'OPEN',
      reason: 'DELIVERING_FAILED: delivery_aborted | destination unreachable',
    })
  })

  it('SWAPPING → FAILED: marks order FAILED but does NOT create a RefundCase', async () => {
    const orderId = 'ord_e2e_swap_fail'
    const invoiceId = 'inv_e2e_swap_fail'
    await seedOrder({ orderId, invoiceId, status: 'SWAPPING' })

    await postWebhook(
      buildPayload({ orderId, event: 'order.failed' }),
      '1714000002000',
    ).expect(204)

    const order = await prisma.flashnetOrder.findFirst({ where: { orderId } })
    expect(order!.status).toBe('FAILED')

    const refundCases = await prisma.refundCase.findMany({ where: { invoiceId } })
    expect(refundCases).toHaveLength(0)
  })

  it('DELIVERING → DELIVERED (happy path): does NOT create a RefundCase', async () => {
    const orderId = 'ord_e2e_delivered'
    const invoiceId = 'inv_e2e_delivered'
    await seedOrder({ orderId, invoiceId, status: 'DELIVERING' })

    await postWebhook(
      buildPayload({
        orderId,
        event: 'order.completed',
        amountOut: '1000000',
      }),
      '1714000003000',
    ).expect(204)

    const order = await prisma.flashnetOrder.findFirst({ where: { orderId } })
    expect(order!.status).toBe('DELIVERED')

    const refundCases = await prisma.refundCase.findMany({ where: { invoiceId } })
    expect(refundCases).toHaveLength(0)
  })

  it('idempotent: replaying the same DELIVERING → FAILED webhook leaves exactly one RefundCase', async () => {
    const orderId = 'ord_e2e_idempotent'
    const invoiceId = 'inv_e2e_idempotent'
    await seedOrder({ orderId, invoiceId, status: 'DELIVERING' })

    const payload = buildPayload({
      orderId,
      event: 'order.failed',
      error: { code: 'delivery_aborted', message: 'sim' },
    })
    const ts = '1714000004000'

    // First delivery: opens the case.
    await postWebhook(payload, ts).expect(204)
    // Replay (Flashnet at-least-once): webhook event row dedupes by (orderId, event, timestamp).
    await postWebhook(payload, ts).expect(204)

    const refundCases = await prisma.refundCase.findMany({ where: { invoiceId } })
    expect(refundCases).toHaveLength(1)
  })

  // ---------------------------------------------------------------------------
  // GET /v1/internal/refund-cases (ops endpoint)
  // ---------------------------------------------------------------------------

  it('GET /v1/internal/refund-cases — returns the open case after the webhook fires', async () => {
    const orderId = 'ord_e2e_get'
    const invoiceId = 'inv_e2e_get'
    await seedOrder({ orderId, invoiceId, status: 'DELIVERING' })

    await postWebhook(
      buildPayload({
        orderId,
        event: 'order.failed',
        error: { code: 'delivery_aborted', message: 'sim' },
      }),
      '1714000005000',
    ).expect(204)

    const res = await request(app.getHttpServer())
      .get('/v1/internal/refund-cases')
      .set('Authorization', `Bearer ${TEST_OPS_TOKEN}`)
      .expect(200)

    expect(res.body.total).toBe(1)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({ invoiceId, status: 'OPEN' })
  })

  it('GET /v1/internal/refund-cases — rejects requests without a bearer token', async () => {
    await request(app.getHttpServer())
      .get('/v1/internal/refund-cases')
      .expect(401)
  })

  it('GET /v1/internal/refund-cases — rejects requests with the wrong token', async () => {
    await request(app.getHttpServer())
      .get('/v1/internal/refund-cases')
      .set('Authorization', 'Bearer not-the-real-token')
      .expect(401)
  })
})
