import { Injectable, Logger } from '@nestjs/common';
import {
  OnrampOrderRequest,
  OnrampOrderResponse,
  OrderStatusResponse,
} from './flashnet.types';

/**
 * Deterministic mock of FlashnetService for test environments.
 * Activated by FlashnetModule factory when FLASHNET_API_KEY is absent.
 */
@Injectable()
export class FlashnetMockService {
  private readonly logger = new Logger(FlashnetMockService.name);

  async createOnrampOrder(
    params: OnrampOrderRequest,
    _idempotencyKey: string,
  ): Promise<OnrampOrderResponse> {
    this.logger.log({ event: 'flashnet.mock.createOnrampOrder', params });

    const orderId = `ord_mock_${randomHex(8)}`;
    const quoteId = `q_mock_${randomHex(8)}`;
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();

    return {
      orderId,
      quoteId,
      depositAddress: `lnbcmock${randomHex(16)}`,
      amountIn: params.amount,
      estimatedOut: '920000',
      feeAmount: '10000',
      roundingFeeAmount: '2162',
      totalFeeAmount: '12162',
      feeBps: 41,
      feeAsset: 'USDB',
      route: ['BTC', 'USDB'],
      expiresAt,
      priceLockMode: 'approval_required',
      lockedMinAmountOut: '838945',
      amountMode: 'exact_in',
      lightningReceiveRequestId: `SparkLightningReceiveRequest:mock-${randomHex(8)}`,
    };
  }

  async getOrderStatus(orderId: string): Promise<OrderStatusResponse> {
    this.logger.log({ event: 'flashnet.mock.getOrderStatus', orderId });
    return {
      orderId,
      status: 'completed',
      amountOut: '920000',
      errorCode: undefined,
      errorMessage: undefined,
    };
  }

  verifyWebhookSignature(
    _rawBody: Buffer | string,
    _signature: string,
    _timestamp: string,
  ): boolean {
    return true;
  }
}

function randomHex(bytes: number): string {
  // Deterministic in test? No — but the spec asks for random-looking mock IDs,
  // and tests assert shape not exact values.
  return Buffer.from(
    Array.from({ length: bytes }, () => Math.floor(Math.random() * 256)),
  ).toString('hex');
}
