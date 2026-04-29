import { Test, TestingModule } from '@nestjs/testing'
import { Logger, UnauthorizedException } from '@nestjs/common'
import { FlashnetWebhookController } from './flashnet-webhook.controller'
import { SwapService } from './swap.service'
import { PrismaService } from '../prisma/prisma.service'
import { FLASHNET_SERVICE } from '../flashnet/flashnet.module'
import { FlashnetWebhookPayload } from '../flashnet/flashnet.types'

// ---------------------------------------------------------------------------
// Helpers / mocks
// ---------------------------------------------------------------------------

function makeSwapServiceMock() {
  return {
    applyWebhookEvent: jest.fn().mockResolvedValue(undefined),
  }
}

function makeFlashnetMock(verifyResult = true) {
  return {
    verifyWebhookSignature: jest.fn().mockReturnValue(verifyResult),
  }
}

function makePrismaMock() {
  return {}
}

/** Build a fake Express Request object for the controller.
 *
 * When `headers` is provided, it replaces the default headers entirely so
 * individual header-absent tests can omit specific headers. If not provided,
 * both HMAC headers are present by default.
 */
function makeRequest(overrides: {
  rawBody?: Buffer | undefined
  /** When supplied, completely replaces the default headers (not merged). */
  headers?: Record<string, string>
  body?: unknown
  url?: string
} = {}) {
  const defaultPayload: FlashnetWebhookPayload = {
    event: 'order.completed',
    timestamp: '1714000000000',
    data: {
      id: 'ord_test_001',
      status: 'completed',
      amountOut: '920000',
      feeAmount: '10000',
      error: { code: null, message: null },
    },
  }

  const rawBody = 'rawBody' in overrides
    ? overrides.rawBody
    : Buffer.from(JSON.stringify(defaultPayload), 'utf8')

  const headers = overrides.headers !== undefined
    ? overrides.headers
    : {
        'x-flashnet-signature': 'valid_sig',
        'x-flashnet-timestamp': '1714000000000',
      }

  return {
    rawBody,
    headers,
    body: overrides.body ?? defaultPayload,
    url: overrides.url ?? '/v1/internal/flashnet/webhook',
  } as unknown as import('express').Request
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FlashnetWebhookController', () => {
  let controller: FlashnetWebhookController
  let swapServiceMock: ReturnType<typeof makeSwapServiceMock>
  let flashnetMock: ReturnType<typeof makeFlashnetMock>

  async function buildModule(verifyResult = true) {
    swapServiceMock = makeSwapServiceMock()
    flashnetMock = makeFlashnetMock(verifyResult)

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FlashnetWebhookController],
      providers: [
        { provide: SwapService, useValue: swapServiceMock },
        { provide: PrismaService, useValue: makePrismaMock() },
        { provide: FLASHNET_SERVICE, useValue: flashnetMock },
      ],
    }).compile()

    controller = module.get<FlashnetWebhookController>(FlashnetWebhookController)
  }

  beforeEach(async () => {
    await buildModule()
  })

  afterEach(() => jest.restoreAllMocks())

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('happy path', () => {
    it('valid HMAC + valid event payload → resolves (204 semantics)', async () => {
      const req = makeRequest()

      await expect(controller.handleWebhook(req)).resolves.toBeUndefined()
      expect(swapServiceMock.applyWebhookEvent).toHaveBeenCalledTimes(1)
    })

    it('stamps header timestamp into parsed payload before dispatch', async () => {
      const req = makeRequest({ headers: { 'x-flashnet-signature': 'sig', 'x-flashnet-timestamp': '9999999999999' } })

      await controller.handleWebhook(req)

      const dispatched = swapServiceMock.applyWebhookEvent.mock.calls[0][0] as FlashnetWebhookPayload
      expect(dispatched.timestamp).toBe('9999999999999')
    })
  })

  // -------------------------------------------------------------------------
  // HMAC / header validation
  // -------------------------------------------------------------------------

  describe('HMAC and header validation', () => {
    it('missing X-Flashnet-Signature header → throws UnauthorizedException', async () => {
      // Only timestamp present; signature absent.
      const req = makeRequest({
        headers: { 'x-flashnet-timestamp': '1714000000000' },
      })

      await expect(controller.handleWebhook(req)).rejects.toThrow(UnauthorizedException)
      expect(swapServiceMock.applyWebhookEvent).not.toHaveBeenCalled()
    })

    it('missing X-Flashnet-Timestamp header → throws UnauthorizedException', async () => {
      // Only signature present; timestamp absent.
      const req = makeRequest({
        headers: { 'x-flashnet-signature': 'valid_sig' },
      })

      await expect(controller.handleWebhook(req)).rejects.toThrow(UnauthorizedException)
      expect(swapServiceMock.applyWebhookEvent).not.toHaveBeenCalled()
    })

    it('both HMAC headers absent → throws UnauthorizedException', async () => {
      const req = makeRequest({ headers: {} })

      await expect(controller.handleWebhook(req)).rejects.toThrow(UnauthorizedException)
    })

    it('invalid HMAC (verifyWebhookSignature returns false) → throws UnauthorizedException', async () => {
      // Per concern #2: mock verifyWebhookSignature directly to return false so
      // the rejection path is exercised even though FlashnetMockService always returns true.
      await buildModule(false /* verifyResult */)

      const req = makeRequest()
      await expect(controller.handleWebhook(req)).rejects.toThrow(UnauthorizedException)
      expect(swapServiceMock.applyWebhookEvent).not.toHaveBeenCalled()
    })

    it('invalid HMAC → UnauthorizedException message is "Invalid webhook signature"', async () => {
      await buildModule(false)
      const req = makeRequest()

      let caught: UnauthorizedException | undefined
      try {
        await controller.handleWebhook(req)
      } catch (e) {
        caught = e as UnauthorizedException
      }

      expect(caught).toBeInstanceOf(UnauthorizedException)
      expect(caught!.message).toBe('Invalid webhook signature')
    })
  })

  // -------------------------------------------------------------------------
  // Missing rawBody — concern #3
  // -------------------------------------------------------------------------

  describe('rawBody absent', () => {
    it('req.rawBody undefined → throws an error (400 semantics)', async () => {
      // FIXME: The controller throws `Object.assign(new Error('Raw body unavailable'), { status: 400 })`
      // which is a plain Error with a .status property, NOT a NestJS BadRequestException.
      // NestJS's default exception filter does NOT map plain Errors to 400 — it will produce a 500.
      // This is a production defect: callers will receive 500 instead of 400 when rawBody is absent.
      // Do NOT fix here — flagged for QA adjudication.
      const req = makeRequest({ rawBody: undefined })

      await expect(controller.handleWebhook(req)).rejects.toThrow('Raw body unavailable')
      expect(swapServiceMock.applyWebhookEvent).not.toHaveBeenCalled()
    })

    it('req.rawBody absent — the thrown error has status 400 property set', async () => {
      const req = makeRequest({ rawBody: undefined })

      let caught: Error | undefined
      try {
        await controller.handleWebhook(req)
      } catch (e) {
        caught = e as Error
      }

      expect(caught).toBeDefined()
      expect((caught as Error & { status?: number }).status).toBe(400)
      // NOTE: Despite the .status:400 property, NestJS default exception filter
      // reads HTTP status from HttpException.getStatus(), which a plain Error does not have.
      // The server will respond with 500, not 400. See FIXME above.
    })
  })

  // -------------------------------------------------------------------------
  // Malformed JSON body — after valid HMAC
  // -------------------------------------------------------------------------

  describe('malformed JSON body', () => {
    it('malformed JSON after valid HMAC → returns without calling applyWebhookEvent (204 semantics)', async () => {
      const req = makeRequest({
        rawBody: Buffer.from('{not valid json', 'utf8'),
      })

      // Should resolve cleanly (return early with 204) rather than propagate the parse error.
      await expect(controller.handleWebhook(req)).resolves.toBeUndefined()
      expect(swapServiceMock.applyWebhookEvent).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Dedupe — applyWebhookEvent is called exactly once per delivery
  // -------------------------------------------------------------------------

  describe('deduplication wiring', () => {
    it('second call with same payload → applyWebhookEvent called again (dedupe is inside SwapService, not controller)', async () => {
      const req = makeRequest()

      await controller.handleWebhook(req)
      await controller.handleWebhook(req)

      // The controller always dispatches to SwapService; deduplication is SwapService's responsibility.
      expect(swapServiceMock.applyWebhookEvent).toHaveBeenCalledTimes(2)
    })
  })

  // -------------------------------------------------------------------------
  // Logger behaviour (smoke test — confirms structured log fields)
  // -------------------------------------------------------------------------

  describe('logging', () => {
    it('logs flashnet.webhook.received with orderId and webhookEvent', async () => {
      const logSpy = jest.spyOn(controller['logger'], 'log')
      const req = makeRequest()

      await controller.handleWebhook(req)

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'flashnet.webhook.received',
          orderId: 'ord_test_001',   // resolved from data.id
          webhookEvent: 'order.completed',
        }),
      )
    })

    it('missing headers → logs flashnet.webhook.missing_headers warning', async () => {
      const warnSpy = jest.spyOn(controller['logger'], 'warn')
      const req = makeRequest({ headers: {} })

      await expect(controller.handleWebhook(req)).rejects.toThrow(UnauthorizedException)

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'flashnet.webhook.missing_headers' }),
      )
    })

    it('invalid HMAC → logs flashnet.webhook.invalid_signature warning', async () => {
      await buildModule(false)
      const warnSpy = jest.spyOn(controller['logger'], 'warn')
      const req = makeRequest()

      await expect(controller.handleWebhook(req)).rejects.toThrow(UnauthorizedException)

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'flashnet.webhook.invalid_signature' }),
      )
    })
  })
})
