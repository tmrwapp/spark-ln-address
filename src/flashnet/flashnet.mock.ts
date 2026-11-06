import { Injectable, Logger } from '@nestjs/common'
import {
  LightningQuoteRequest,
  LightningQuoteResponse,
  OrderStatusResponse,
} from './flashnet.types'
import { isTestEnvironment } from './flashnet-environment'

/**
 * Deterministic mock of FlashnetService for test environments.
 * Activated by FlashnetModule factory when FLASHNET_API_KEY is absent AND
 * NODE_ENV is 'test'. Never used in development or production.
 */
@Injectable()
export class FlashnetMockService {
  private readonly logger = new Logger(FlashnetMockService.name)

  async createLightningQuote(
    params: LightningQuoteRequest,
    _idempotencyKey: string,
  ): Promise<LightningQuoteResponse> {
    void _idempotencyKey
    this.logger.log({ event: 'flashnet.mock.createLightningQuote', params })

    const quoteId = `q_mock_${randomHex(8)}`
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString()

    return {
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
      replayed: false,
    }
  }

  async getQuoteOrder(_quoteId: string): Promise<null> {
    void _quoteId
    return null
  }

  async getOrderStatus(orderId: string): Promise<OrderStatusResponse> {
    this.logger.log({ event: 'flashnet.mock.getOrderStatus', orderId })
    return {
      orderId,
      status: 'completed',
      amountOut: '920000',
      errorCode: undefined,
      errorMessage: undefined,
    }
  }

  verifyWebhookSignature(
    _rawBody: Buffer | string,
    _signature: string,
    _timestamp: string,
  ): boolean {
    void _rawBody
    void _signature
    void _timestamp
    // Accept-all only under the test runner. FlashnetModule never selects the
    // mock elsewhere; this is the second line of defence (issue 31).
    return isTestEnvironment()
  }
}

function randomHex(bytes: number): string {
  // Deterministic in test? No — but the spec asks for random-looking mock IDs,
  // and tests assert shape not exact values.
  return Buffer.from(
    Array.from({ length: bytes }, () => Math.floor(Math.random() * 256)),
  ).toString('hex')
}
