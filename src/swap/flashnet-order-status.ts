export const FLASHNET_ORDER_STATUS = {
  // Local-only initial state, set on order creation before Flashnet has emitted
  // any webhook. Not part of the Flashnet documented lifecycle.
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  // Flashnet documented statuses
  // (https://docs.flashnet.xyz/products/orchestration/order-lifecycle).
  // Internal SCREAMING_SNAKE_CASE; Flashnet's wire status `completed` maps to
  // our `DELIVERED` constant — all other names mirror the docs 1:1.
  PROCESSING: 'PROCESSING',
  CONFIRMING: 'CONFIRMING',
  BRIDGING: 'BRIDGING',
  SWAPPING: 'SWAPPING',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  PAUSED: 'PAUSED',
  DELIVERING: 'DELIVERING',
  DELIVERED: 'DELIVERED',
  REFUNDING: 'REFUNDING',
  REFUNDED: 'REFUNDED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  UNFULFILLED: 'UNFULFILLED',
} as const

export type FlashnetOrderStatus = (typeof FLASHNET_ORDER_STATUS)[keyof typeof FLASHNET_ORDER_STATUS]
