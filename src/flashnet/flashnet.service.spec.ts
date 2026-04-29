import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { FlashnetService } from './flashnet.service';
import { FlashnetMockService } from './flashnet.mock';
import { FLASHNET_SERVICE, FlashnetModule } from './flashnet.module';
import { OnrampOrderRequest, OnrampOrderResponse } from './flashnet.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(overrides: Record<string, string> = {}): Partial<ConfigService> {
  const defaults: Record<string, string> = {
    FLASHNET_API_BASE: 'https://orchestration.flashnet.xyz',
    FLASHNET_API_KEY: 'fn_test_key',
    FLASHNET_WEBHOOK_SECRET: 'test_webhook_secret',
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => defaults[key] ?? undefined),
  };
}

const SAMPLE_REQUEST: OnrampOrderRequest = {
  destinationChain: 'spark',
  destinationAsset: 'USDB',
  recipientAddress: 'spark1qtest',
  amount: '1000',
  amountMode: 'exact_in',
  slippageBps: 50,
};

const SAMPLE_RESPONSE: Omit<OnrampOrderResponse, 'replayed'> = {
  orderId: 'ord_abc123',
  quoteId: 'q_def456',
  depositAddress: 'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdql2pshjmt9de6zqmt9w3skgct5dfskvn0wyfkx7em9wvk2um5nah8aqtqxqyz0vq',
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
  lightningReceiveRequestId: 'SparkLightningReceiveRequest:test-001',
};

/** Helper: builds a mock Response-like object for a successful onramp call. */
function makeOkOnrampResponse(replayedHeader = 'false') {
  return {
    ok: true,
    headers: { get: (name: string) => (name === 'x-idempotency-replayed' ? replayedHeader : null) },
    json: async () => SAMPLE_RESPONSE,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// FlashnetService unit tests
// ---------------------------------------------------------------------------

describe('FlashnetService', () => {
  let service: FlashnetService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlashnetService,
        { provide: ConfigService, useValue: makeConfigService() },
      ],
    }).compile();

    service = module.get(FlashnetService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // createOnrampOrder
  // -------------------------------------------------------------------------

  describe('createOnrampOrder', () => {
    it('happy path — returns typed OnrampOrderResponse with replayed: false', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(makeOkOnrampResponse());

      const result = await service.createOnrampOrder(SAMPLE_REQUEST, 'idem-key-1');

      expect(result).toMatchObject({
        orderId: 'ord_abc123',
        quoteId: 'q_def456',
        estimatedOut: '920000',
        replayed: false,
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://orchestration.flashnet.xyz/v1/orchestration/onramp',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer fn_test_key',
            'X-Idempotency-Key': 'idem-key-1',
          }),
        }),
      );
    });

    // -------------------------------------------------------------------------
    // PR5: X-Idempotency-Replayed header surfacing
    // -------------------------------------------------------------------------

    it('X-Idempotency-Replayed: true — returns replayed: true', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce(makeOkOnrampResponse('true'));

      const result = await service.createOnrampOrder(SAMPLE_REQUEST, 'idem-replayed-true');

      expect(result.replayed).toBe(true);
    });

    it('X-Idempotency-Replayed header absent (null) — returns replayed: false', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        headers: { get: (_name: string) => null },
        json: async () => SAMPLE_RESPONSE,
      } as unknown as Response);

      const result = await service.createOnrampOrder(SAMPLE_REQUEST, 'idem-no-header');

      expect(result.replayed).toBe(false);
    });

    it("X-Idempotency-Replayed: 'false' string — returns replayed: false", async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce(makeOkOnrampResponse('false'));

      const result = await service.createOnrampOrder(SAMPLE_REQUEST, 'idem-false-string');

      expect(result.replayed).toBe(false);
    });

    it('400 unsupported_route — throws BadGatewayException', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ code: 'unsupported_route', message: 'Route not supported' }),
      } as Response);

      await expect(
        service.createOnrampOrder(SAMPLE_REQUEST, 'idem-key-2'),
      ).rejects.toThrow(BadGatewayException);
    });

    it('400 unsupported_route — BadGatewayException carries code in response body', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ code: 'unsupported_route', message: 'Route not supported' }),
      } as Response);

      let caught: BadGatewayException | undefined;
      try {
        await service.createOnrampOrder(SAMPLE_REQUEST, 'idem-key-3');
      } catch (e) {
        caught = e as BadGatewayException;
      }
      expect(caught).toBeInstanceOf(BadGatewayException);
      expect((caught!.getResponse() as Record<string, unknown>).code).toBe('unsupported_route');
    });

    it('429 rate_limited — throws BadGatewayException with code rate_limited', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ code: 'rate_limited', message: 'Too many requests' }),
      } as Response);

      let caught: BadGatewayException | undefined;
      try {
        await service.createOnrampOrder(SAMPLE_REQUEST, 'idem-key-4');
      } catch (e) {
        caught = e as BadGatewayException;
      }
      expect(caught).toBeInstanceOf(BadGatewayException);
      expect((caught!.getResponse() as Record<string, unknown>).code).toBe('rate_limited');
    });

    it('409 idempotency_conflict — throws BadGatewayException with code idempotency_conflict', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          code: 'idempotency_conflict',
          message: 'Conflicting payload for idempotency key',
        }),
      } as Response);

      let caught: BadGatewayException | undefined;
      try {
        await service.createOnrampOrder(SAMPLE_REQUEST, 'idem-key-5');
      } catch (e) {
        caught = e as BadGatewayException;
      }
      expect(caught).toBeInstanceOf(BadGatewayException);
      expect((caught!.getResponse() as Record<string, unknown>).code).toBe(
        'idempotency_conflict',
      );
    });

    it('network error — throws ServiceUnavailableException', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(
        service.createOnrampOrder(SAMPLE_REQUEST, 'idem-key-6'),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  // -------------------------------------------------------------------------
  // verifyWebhookSignature
  // -------------------------------------------------------------------------

  describe('verifyWebhookSignature', () => {
    const secret = 'test_webhook_secret';
    const timestamp = '1714000000000';
    const rawBody = JSON.stringify({ orderId: 'ord_abc', event: 'order.completed' });

    function makeSignature(ts: string, body: string): string {
      return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    }

    it('valid signature — returns true', () => {
      const sig = makeSignature(timestamp, rawBody);
      expect(service.verifyWebhookSignature(rawBody, sig, timestamp)).toBe(true);
    });

    it('valid signature with Buffer rawBody — returns true', () => {
      const sig = makeSignature(timestamp, rawBody);
      expect(
        service.verifyWebhookSignature(Buffer.from(rawBody), sig, timestamp),
      ).toBe(true);
    });

    it('tampered body — returns false', () => {
      const sig = makeSignature(timestamp, rawBody);
      const tamperedBody = rawBody.replace('completed', 'failed');
      expect(service.verifyWebhookSignature(tamperedBody, sig, timestamp)).toBe(false);
    });

    it('wrong timestamp — returns false', () => {
      const sig = makeSignature(timestamp, rawBody);
      expect(service.verifyWebhookSignature(rawBody, sig, '9999999999999')).toBe(false);
    });

    it('wrong-length signature — returns false without throwing', () => {
      // timingSafeEqual throws if lengths differ — our guard must prevent that.
      expect(() =>
        service.verifyWebhookSignature(rawBody, 'short', timestamp),
      ).not.toThrow();
      expect(service.verifyWebhookSignature(rawBody, 'short', timestamp)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getOrderStatus
  // -------------------------------------------------------------------------

  describe('getOrderStatus', () => {
    // NOTE: getOrderStatus now uses quoteId (query param), confirmed from Flashnet OpenAPI.
    // The variable name is kept as ORDER_ID here for test readability; use quoteId values in new tests.
    const ORDER_ID = 'q_xyz789';

    const SAMPLE_STATUS_RESPONSE: import('./flashnet.types').OrderStatusResponse = {
      orderId: 'ord_xyz789',
      status: 'completed',
      amountOut: '920000',
    };

    it('happy path — returns typed OrderStatusResponse', async () => {
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => SAMPLE_STATUS_RESPONSE,
      } as Response);

      const result = await service.getOrderStatus(ORDER_ID);

      expect(result).toMatchObject({
        orderId: 'ord_xyz789',
        status: 'completed',
        amountOut: '920000',
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        `https://orchestration.flashnet.xyz/v1/orchestration/order?quoteId=${ORDER_ID}`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer fn_test_key',
          }),
        }),
      );
    });

    it('happy path — processing status without amountOut', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ orderId: ORDER_ID, status: 'processing' }),
      } as Response);

      const result = await service.getOrderStatus(ORDER_ID);

      expect(result).toMatchObject({ orderId: ORDER_ID, status: 'processing' });
    });

    it('non-2xx with JSON error body — throws BadGatewayException with code and message', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ code: 'unsupported_route', message: 'Order not found' }),
      } as Response);

      let caught: BadGatewayException | undefined;
      try {
        await service.getOrderStatus(ORDER_ID);
      } catch (e) {
        caught = e as BadGatewayException;
      }

      expect(caught).toBeInstanceOf(BadGatewayException);
      const body = caught!.getResponse() as Record<string, unknown>;
      expect(body.code).toBe('unsupported_route');
      expect(body.message).toBe('Order not found');
    });

    it('non-2xx with non-JSON error body — throws BadGatewayException with service_unavailable fallback', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => { throw new SyntaxError('Unexpected token'); },
      } as unknown as Response);

      let caught: BadGatewayException | undefined;
      try {
        await service.getOrderStatus(ORDER_ID);
      } catch (e) {
        caught = e as BadGatewayException;
      }

      expect(caught).toBeInstanceOf(BadGatewayException);
      const body = caught!.getResponse() as Record<string, unknown>;
      expect(body.code).toBe('service_unavailable');
      expect(body.message).toBe('HTTP 503');
    });

    it('network error — throws ServiceUnavailableException', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(service.getOrderStatus(ORDER_ID)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('builds URL with quoteId as query parameter (confirmed from Flashnet OpenAPI)', async () => {
      const specificId = 'q_path_check';
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ orderId: specificId, status: 'swapping' }),
      } as Response);

      await service.getOrderStatus(specificId);

      expect(fetchSpy).toHaveBeenCalledWith(
        `https://orchestration.flashnet.xyz/v1/orchestration/order?quoteId=${specificId}`,
        expect.anything(),
      );
    });

    it('concern #5 — URL contains ?quoteId= (not a path param) so future renames cannot silently break routing', async () => {
      // This test verifies that the URL shape matches the Flashnet OpenAPI spec:
      // GET /v1/orchestration/order?quoteId=<value> (query param, NOT path param).
      // NOTE: The method name still says "orderId" for backward compat (JSDoc says rename in PR7).
      // A JSDoc update on getOrderStatus to reflect the quoteId semantics is flagged for QA.
      const quoteId = 'q_abc123';
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ orderId: 'ord_abc123', status: 'completed' }),
      } as Response);

      await service.getOrderStatus(quoteId);

      const calledUrl = (fetchSpy.mock.calls[0] as [string, unknown])[0];
      expect(calledUrl).toContain('?quoteId=');
      expect(calledUrl).not.toMatch(/\/order\/[^?]/); // Must NOT be a path param
    });

    it('concern #5 — quoteId with special chars is percent-encoded via encodeURIComponent', async () => {
      // quoteIds with special characters (e.g. "q abc+def") must be percent-encoded
      // so they do not break the query string. encodeURIComponent is called in the impl.
      const quoteIdWithSpecialChars = 'q abc+def=xyz';
      const encoded = encodeURIComponent(quoteIdWithSpecialChars);

      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ orderId: 'ord_special', status: 'processing' }),
      } as Response);

      await service.getOrderStatus(quoteIdWithSpecialChars);

      const calledUrl = (fetchSpy.mock.calls[0] as [string, unknown])[0];
      expect(calledUrl).toContain(`?quoteId=${encoded}`);
      // Raw (unencoded) string must NOT appear in the URL.
      expect(calledUrl).not.toContain(quoteIdWithSpecialChars);
    });
  });

  // -------------------------------------------------------------------------
  // parseErrorBody — partial JSON body (lines 181-182 ?? fallback branches)
  // -------------------------------------------------------------------------

  describe('parseErrorBody — partial JSON response', () => {
    it('non-2xx with JSON body missing code — uses service_unavailable fallback code', async () => {
      // JSON body has no "code" field: triggers json.code ?? 'service_unavailable'
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({ message: 'Validation failed' }),
      } as Response);

      let caught: BadGatewayException | undefined;
      try {
        await service.createOnrampOrder(SAMPLE_REQUEST, 'idem-partial-code');
      } catch (e) {
        caught = e as BadGatewayException;
      }

      expect(caught).toBeInstanceOf(BadGatewayException);
      const body = caught!.getResponse() as Record<string, unknown>;
      expect(body.code).toBe('service_unavailable');
      expect(body.message).toBe('Validation failed');
    });

    it('non-2xx with JSON body missing message — uses HTTP status fallback message', async () => {
      // JSON body has no "message" field: triggers json.message ?? `HTTP ${status}`
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ code: 'service_unavailable' }),
      } as Response);

      let caught: BadGatewayException | undefined;
      try {
        await service.createOnrampOrder(SAMPLE_REQUEST, 'idem-partial-msg');
      } catch (e) {
        caught = e as BadGatewayException;
      }

      expect(caught).toBeInstanceOf(BadGatewayException);
      const body = caught!.getResponse() as Record<string, unknown>;
      expect(body.code).toBe('service_unavailable');
      expect(body.message).toBe('HTTP 500');
    });
  });

  // -------------------------------------------------------------------------
  // constructor — ?? fallback branches (lines 26-30)
  // -------------------------------------------------------------------------

  describe('constructor — config fallbacks', () => {
    it('uses default apiBase when FLASHNET_API_BASE is not configured', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FlashnetService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(() => undefined),
            },
          },
        ],
      }).compile();

      const svc = module.get(FlashnetService);

      jest.spyOn(global, 'fetch').mockResolvedValueOnce(makeOkOnrampResponse());

      await svc.createOnrampOrder(SAMPLE_REQUEST, 'idem-fallback');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://orchestration.flashnet.xyz/v1/orchestration/onramp',
        expect.anything(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // verifyWebhookSignature — catch block (lines 169-173)
  // -------------------------------------------------------------------------

  describe('verifyWebhookSignature — unexpected crypto error', () => {
    it('returns false (not throw) when createHmac throws unexpectedly', () => {
      // Force the catch block by making the webhookSecret something that
      // triggers an error inside createHmac's update/digest chain.
      // We temporarily reassign the private field via casting.
      // createHmac('sha256', null) throws TypeError at runtime — simulates
      // a bad secret value that bypasses TypeScript's type safety.
      const svc = service as unknown as { webhookSecret: unknown };
      const original = svc.webhookSecret;

      svc.webhookSecret = null as unknown as string;

      expect(() =>
        service.verifyWebhookSignature('body', 'sig', '12345'),
      ).not.toThrow();

      expect(service.verifyWebhookSignature('body', 'sig', '12345')).toBe(false);

      svc.webhookSecret = original;
    });
  });
});

// ---------------------------------------------------------------------------
// FlashnetModule factory — mock vs real selection
// ---------------------------------------------------------------------------

describe('FlashnetModule factory', () => {
  it('returns FlashnetMockService when FLASHNET_API_KEY is empty', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [FlashnetModule],
    })
      .overrideProvider(ConfigService)
      .useValue(makeConfigService({ FLASHNET_API_KEY: '' }))
      .compile();

    const resolved = module.get(FLASHNET_SERVICE);
    expect(resolved).toBeInstanceOf(FlashnetMockService);
  });

  it('returns FlashnetService when FLASHNET_API_KEY is set', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [FlashnetModule],
    })
      .overrideProvider(ConfigService)
      .useValue(makeConfigService({ FLASHNET_API_KEY: 'fn_real_key' }))
      .compile();

    const resolved = module.get(FLASHNET_SERVICE);
    expect(resolved).toBeInstanceOf(FlashnetService);
  });
});
