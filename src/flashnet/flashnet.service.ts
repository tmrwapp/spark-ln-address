import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  FlashnetApiError,
  OnrampOrderRequest,
  OnrampOrderResponse,
  OrderStatusResponse,
} from './flashnet.types';

@Injectable()
export class FlashnetService {
  private readonly logger = new Logger(FlashnetService.name);

  private readonly apiBase: string;
  private readonly apiKey: string;
  private readonly webhookSecret: string;

  constructor(private readonly config: ConfigService) {
    this.apiBase =
      this.config.get<string>('FLASHNET_API_BASE') ??
      'https://orchestration.flashnet.xyz';
    this.apiKey = this.config.get<string>('FLASHNET_API_KEY') ?? '';
    this.webhookSecret =
      this.config.get<string>('FLASHNET_WEBHOOK_SECRET') ?? '';
  }

  /**
   * POST /v1/orchestration/onramp
   * Creates a USDB onramp order. Flashnet issues the BOLT11, takes the LN
   * payment, swaps BTC→USDB, and delivers to recipientAddress.
   */
  async createOnrampOrder(
    params: OnrampOrderRequest,
    idempotencyKey: string,
  ): Promise<OnrampOrderResponse> {
    const url = `${this.apiBase}/v1/orchestration/onramp`;
    let response: Response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'X-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(params),
      });
    } catch (networkError) {
      this.logger.error(
        { event: 'flashnet.network_error', url, error: String(networkError) },
        'Flashnet network error on createOnrampOrder',
      );
      throw new ServiceUnavailableException('Flashnet service unreachable');
    }

    if (!response.ok) {
      const errorBody = await this.parseErrorBody(response);
      this.logger.warn(
        {
          event: 'flashnet.onramp_error',
          status: response.status,
          code: errorBody.code,
          message: errorBody.message,
        },
        'Flashnet onramp returned non-2xx',
      );
      throw new BadGatewayException({
        code: errorBody.code,
        message: errorBody.message,
      });
    }

    return response.json() as Promise<OnrampOrderResponse>;
  }

  /**
   * GET /v1/orchestration/order/:orderId
   * Poll-based fallback for order status when webhooks are missed.
   *
   * NOTE: Spec §7 cites "/v1/orchestration/order" (without trailing ID segment)
   * but the Flashnet quotes-and-orders page strongly implies a path-param form.
   * We use "/v1/orchestration/order/:orderId" here as the most common REST
   * pattern. If Flashnet's actual API differs, this path should be adjusted and
   * flagged for PR6.
   */
  async getOrderStatus(orderId: string): Promise<OrderStatusResponse> {
    const url = `${this.apiBase}/v1/orchestration/order/${orderId}`;
    let response: Response;

    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
    } catch (networkError) {
      this.logger.error(
        {
          event: 'flashnet.network_error',
          url,
          orderId,
          error: String(networkError),
        },
        'Flashnet network error on getOrderStatus',
      );
      throw new ServiceUnavailableException('Flashnet service unreachable');
    }

    if (!response.ok) {
      const errorBody = await this.parseErrorBody(response);
      this.logger.warn(
        {
          event: 'flashnet.order_status_error',
          orderId,
          status: response.status,
          code: errorBody.code,
        },
        'Flashnet getOrderStatus returned non-2xx',
      );
      throw new BadGatewayException({
        code: errorBody.code,
        message: errorBody.message,
      });
    }

    return response.json() as Promise<OrderStatusResponse>;
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
        rawBody instanceof Buffer ? rawBody.toString('utf8') : rawBody;
      const payload = `${timestamp}.${bodyStr}`;
      const expected = createHmac('sha256', this.webhookSecret)
        .update(payload)
        .digest('hex');

      const expectedBuf = Buffer.from(expected, 'utf8');
      const receivedBuf = Buffer.from(signature, 'utf8');

      // timingSafeEqual throws if lengths differ — guard explicitly.
      if (expectedBuf.length !== receivedBuf.length) {
        return false;
      }

      return timingSafeEqual(expectedBuf, receivedBuf);
    } catch (err) {
      this.logger.error(
        { event: 'flashnet.hmac_error', error: String(err) },
        'Error in verifyWebhookSignature',
      );
      return false;
    }
  }

  private async parseErrorBody(response: Response): Promise<FlashnetApiError> {
    try {
      const json = (await response.json()) as Partial<FlashnetApiError>;
      return {
        code: json.code ?? ('service_unavailable' as FlashnetApiError['code']),
        message: json.message ?? `HTTP ${response.status}`,
      };
    } catch {
      return {
        code: 'service_unavailable',
        message: `HTTP ${response.status}`,
      };
    }
  }
}
