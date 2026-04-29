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

export type FlashnetErrorCode =
  | 'unsupported_route'
  | 'invalid_address'
  | 'rate_limited'
  | 'service_unavailable'
  | 'idempotency_conflict'
  | 'quote_expired'
  | 'slippage_exceeded';

export interface FlashnetApiError {
  code: FlashnetErrorCode;
  message: string;
}
