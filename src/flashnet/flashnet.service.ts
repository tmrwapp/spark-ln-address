import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHmac, timingSafeEqual } from 'crypto'
import {
  FlashnetApiError,
  FlashnetWebhookData,
  LightningQuoteRequest,
  LightningQuoteResponse,
  OrderStatusResponse,
} from './flashnet.types'
import { validateLightningQuote } from './lightning-quote-validation'

@Injectable()
export class FlashnetService {
  private readonly logger = new Logger(FlashnetService.name)

  private readonly apiBase: string
  private readonly apiKey: string
  private readonly webhookSecret: string

  constructor(private readonly config: ConfigService) {
    this.apiBase =
      this.config.get<string>('FLASHNET_API_BASE') ??
      'https://orchestration.flashnet.xyz'
    this.apiKey = this.config.get<string>('FLASHNET_API_KEY') ?? ''
    this.webhookSecret =
      this.config.get<string>('FLASHNET_WEBHOOK_SECRET') ?? ''
  }

  /**
   * POST /v1/orchestration/quote
   * Creates a Lightning-funded USDB quote. The order exists only after the LN
   * payment, swaps BTC→USDB, and delivers to recipientAddress.
   */
  async createLightningQuote(
    params: LightningQuoteRequest,
    idempotencyKey: string,
  ): Promise<LightningQuoteResponse> {
    const url = `${this.apiBase}/v1/orchestration/quote`
    let response: Response

    try {
      response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(params),
      })
    } catch (networkError) {
      this.logger.error(
        { event: 'flashnet.network_error', url, error: String(networkError) },
        'Flashnet network error on createLightningQuote',
      )
      throw new ServiceUnavailableException('Flashnet service unreachable')
    }

    if (!response.ok) {
      const errorBody = await this.parseErrorBody(response)
      this.logger.warn(
        {
          event: 'flashnet.quote_error',
          status: response.status,
          code: errorBody.code,
          message: errorBody.message,
        },
        'Flashnet quote returned non-2xx',
      )
      throw new BadGatewayException({
        code: errorBody.code,
        message: errorBody.message,
      })
    }

    const replayed = response.headers.get('x-idempotency-replayed') === 'true'
    const body = (await response.json()) as Omit<
      LightningQuoteResponse,
      'replayed'
    >
    await validateLightningQuote(body, params.amount)
    return { ...body, replayed }
  }

  /** An unfunded quote legitimately has no order yet. Never fabricate an ID. */
  async getQuoteOrder(quoteId: string): Promise<FlashnetWebhookData | null> {
    const url = `${this.apiBase}/v1/orchestration/order?quoteId=${encodeURIComponent(quoteId)}`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok)
      throw new ServiceUnavailableException('Quote status unavailable')
    const body = (await response.json()) as {
      order?: FlashnetWebhookData | null
    }
    if (body.order === null) return null
    if (
      !body.order ||
      typeof body.order.id !== 'string' ||
      !body.order.id.startsWith('ord_') ||
      body.order.quoteId !== quoteId ||
      typeof body.order.status !== 'string' ||
      typeof body.order.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(body.order.updatedAt))
    ) {
      throw new BadGatewayException('Invalid quote status')
    }
    return body.order
  }

  /**
   * GET /v1/orchestration/order?quoteId=...
   * Poll-based fallback for order status when webhooks are missed.
   *
   * Confirmed against Flashnet OpenAPI (PR6): the endpoint is
   * GET /v1/orchestration/order with a required "quoteId" query parameter —
   * NOT a path-param form (/order/:orderId). The parameter name is "quoteId",
   * so callers should pass the FlashnetOrder.quoteId value here, not orderId.
   * The method signature keeps "orderId" in name only for backward compat;
   * rename to quoteId in PR7 when the scheduler wires this up.
   */
  async getOrderStatus(quoteId: string): Promise<OrderStatusResponse> {
    const url = `${this.apiBase}/v1/orchestration/order?quoteId=${encodeURIComponent(quoteId)}`
    let response: Response

    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      })
    } catch (networkError) {
      this.logger.error(
        {
          event: 'flashnet.network_error',
          url,
          quoteId,
          error: String(networkError),
        },
        'Flashnet network error on getOrderStatus',
      )
      throw new ServiceUnavailableException('Flashnet service unreachable')
    }

    if (!response.ok) {
      const errorBody = await this.parseErrorBody(response)
      this.logger.warn(
        {
          event: 'flashnet.order_status_error',
          quoteId,
          status: response.status,
          code: errorBody.code,
        },
        'Flashnet getOrderStatus returned non-2xx',
      )
      throw new BadGatewayException({
        code: errorBody.code,
        message: errorBody.message,
      })
    }

    return response.json() as Promise<OrderStatusResponse>
  }

  /**
   * Verifies a Flashnet webhook signature.
   *
   * Algorithm: HMAC-SHA256(FLASHNET_WEBHOOK_SECRET, `${timestamp}.${rawBody}`)
   * compared against the X-Flashnet-Signature header value (hex).
   *
   * Uses crypto.timingSafeEqual for constant-time comparison to prevent timing
   * attacks. Returns false (not throw) if lengths differ.
   */
  verifyWebhookSignature(
    rawBody: Buffer | string,
    signature: string,
    timestamp: string,
  ): boolean {
    try {
      const bodyStr =
        rawBody instanceof Buffer ? rawBody.toString('utf8') : rawBody
      const payload = `${timestamp}.${bodyStr}`
      const expected = createHmac('sha256', this.webhookSecret)
        .update(payload)
        .digest('hex')

      const expectedBuf = Buffer.from(expected, 'utf8')
      const receivedBuf = Buffer.from(signature, 'utf8')

      // timingSafeEqual throws if lengths differ — guard explicitly.
      if (expectedBuf.length !== receivedBuf.length) {
        return false
      }

      return timingSafeEqual(expectedBuf, receivedBuf)
    } catch (err) {
      this.logger.error(
        { event: 'flashnet.hmac_error', error: String(err) },
        'Error in verifyWebhookSignature',
      )
      return false
    }
  }

  private async parseErrorBody(response: Response): Promise<FlashnetApiError> {
    try {
      const json = (await response.json()) as Partial<FlashnetApiError>
      return {
        code: json.code ?? ('service_unavailable' as FlashnetApiError['code']),
        message: json.message ?? `HTTP ${response.status}`,
      }
    } catch {
      return {
        code: 'service_unavailable',
        message: `HTTP ${response.status}`,
      }
    }
  }
}
