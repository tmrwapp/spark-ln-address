/**
 * Flashnet orchestration API types — hand-rolled from the Flashnet OpenAPI spec.
 * All USDB amount fields are integer strings in smallest units (6 decimals).
 * Example: "920000" = 0.92 USDB. PR5's SwapService owns the conversion to Decimal.
 */

export interface OnrampOrderRequest {
  destinationChain: 'spark';
  destinationAsset: 'USDB';
  recipientAddress: string;
  /** Amount in satoshis (for exact_in Lightning source), as a string. */
  amount: string;
  amountMode: 'exact_in';
  slippageBps: number;
  refundAddress?: string;
}

export interface OnrampOrderResponse {
  orderId: string;
  quoteId: string;
  /** The BOLT11 invoice the LN payer should pay. */
  depositAddress: string;
  /** Sats in; integer string. */
  amountIn: string;
  /** USDB out (smallest units, 6 decimals); integer string. */
  estimatedOut: string;
  /** Base fee; integer string, smallest USDB units. */
  feeAmount: string;
  /** Rounding dust fee; integer string, smallest USDB units. */
  roundingFeeAmount: string;
  /** Total fee (feeAmount + roundingFeeAmount); integer string. */
  totalFeeAmount: string;
  feeBps: number;
  feeAsset: string;
  /** E.g. ["BTC", "USDB"] */
  route: string[];
  /** ISO 8601 datetime; quote AND BOLT11 share this TTL (~2 min). */
  expiresAt: string;
  priceLockMode: string;
  /** Minimum USDB guaranteed to the recipient after slippage; integer string. */
  lockedMinAmountOut: string;
  amountMode: string;
  lightningReceiveRequestId: string;
  /** Ephemeral payer affordances; shape may vary. Not persisted in v1. */
  paymentLinks?: Record<string, unknown>;
  /**
   * True when Flashnet replayed a cached response for the same X-Idempotency-Key.
   * Surfaced from the X-Idempotency-Replayed response header by FlashnetService.
   * Always false in FlashnetMockService.
   */
  replayed: boolean;
}

export interface OrderStatusResponse {
  orderId: string;
  /**
   * Flashnet lifecycle status string. Kept as `string` so PR6's state machine
   * can handle transitions without a type-level change when new statuses appear.
   * Known values: processing | confirming | swapping | delivering | completed |
   *               failed | refunding | refunded
   */
  status: string;
  /** USDB delivered; integer string, smallest units. Present on completed. */
  amountOut?: string;
  /** Machine-readable error code; present on failed/refunded. */
  errorCode?: string;
  /** Human-readable error message; present on failed/refunded. */
  errorMessage?: string;
}

/**
 * Error codes returned synchronously on Flashnet HTTP API calls (4xx/5xx).
 * Used in FlashnetService.createOnrampOrder and FlashnetApiError.
 */
export type FlashnetApiErrorCode =
  | 'unsupported_route'
  | 'invalid_address'
  | 'rate_limited'
  | 'service_unavailable'
  | 'idempotency_conflict'
  | 'quote_expired'

/**
 * Error codes that appear in terminal webhook events (order.failed, order.refunded).
 * Persisted to FlashnetOrder.errorCode by the webhook handler.
 */
export type FlashnetWebhookErrorCode =
  | 'slippage_exceeded'
  | 'target_unmet'
  | 'delivery_failed'

/**
 * Union of all known Flashnet error codes (API + webhook).
 * @deprecated Prefer FlashnetApiErrorCode or FlashnetWebhookErrorCode for new code.
 */
export type FlashnetErrorCode = FlashnetApiErrorCode | FlashnetWebhookErrorCode

export interface FlashnetApiError {
  code: FlashnetApiErrorCode
  message: string
}

/**
 * Parsed representation of a Flashnet webhook delivery.
 *
 * Envelope shape per docs (https://docs.flashnet.xyz/products/orchestration/api/webhook-events):
 *
 *   {
 *     "event": "order.<status>",          // top-level
 *     "timestamp": "2026-02-04T01:30:47.000Z", // ISO 8601; top-level
 *     "data": {                            // full order snapshot
 *       "id": "ord_...",
 *       "amountOut": string | null,
 *       "feeAmount": string,
 *       "error": { "code": string | null, "message": string | null },
 *       ...
 *     }
 *   }
 *
 * The raw body is preserved separately for HMAC verification.
 * `timestamp` is overwritten by the controller with the X-Flashnet-Timestamp
 * header value (millisecond epoch string) before dispatch to SwapService, so
 * the BigInt conversion in applyWebhookEvent remains correct.
 */
export interface FlashnetWebhookData {
  /** Order ID (ord_...). */
  id: string
  /** Partner-visible order status string. */
  status: string
  /** Output amount in smallest units; null until delivery. */
  amountOut: string | null
  /** Platform fee in smallest units. Always present. */
  feeAmount: string
  /** Error details; code/message are null unless order has failed or requires action. */
  error: {
    code: string | null
    message: string | null
  }
}

export interface FlashnetWebhookPayload {
  /** Webhook event name, e.g. "order.processing", "order.completed". */
  event: string
  /**
   * ISO 8601 delivery timestamp from the envelope.
   * The controller overwrites this with the X-Flashnet-Timestamp header
   * (millisecond epoch string) before passing to applyWebhookEvent, so the
   * dedupe key BigInt conversion is correct regardless of body timestamp format.
   */
  timestamp: string
  /** Full order snapshot at the moment the event was emitted. */
  data: FlashnetWebhookData
}
