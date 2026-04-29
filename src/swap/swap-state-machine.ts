import { FLASHNET_ORDER_STATUS, FlashnetOrderStatus } from './flashnet-order-status'
const {
  PENDING_PAYMENT,
  PROCESSING,
  CONFIRMING,
  BRIDGING,
  SWAPPING,
  AWAITING_APPROVAL,
  PAUSED,
  DELIVERING,
  DELIVERED,
  REFUNDING,
  REFUNDED,
  FAILED,
  EXPIRED,
  UNFULFILLED,
} = FLASHNET_ORDER_STATUS

/**
 * State machine for Flashnet order lifecycle.
 *
 * Mirrors the "Allowed Transitions" table at
 * https://docs.flashnet.xyz/products/orchestration/order-lifecycle —
 * any change here must trace back to that table.
 *
 * Naming: Flashnet's wire status `completed` maps to our `DELIVERED` constant;
 * every other name mirrors the docs 1:1 in SCREAMING_SNAKE_CASE.
 *
 * `PENDING_PAYMENT` is local-only (not in the docs). It represents an order
 * before any Flashnet webhook has arrived; its only outbound edge is to
 * `PROCESSING`.
 *
 * Terminal states (no outbound transitions): `DELIVERED`, `FAILED`, `EXPIRED`,
 * `REFUNDED`.
 */

const ALLOWED_TRANSITIONS: Record<FlashnetOrderStatus, ReadonlySet<FlashnetOrderStatus>> = {
  // Local-only initial state.
  [PENDING_PAYMENT]: new Set([PROCESSING]),

  [PROCESSING]: new Set([
    CONFIRMING,
    BRIDGING,
    SWAPPING,
    AWAITING_APPROVAL,
    PAUSED,
    REFUNDING,
    DELIVERING,
    DELIVERED,
    FAILED,
    EXPIRED,
    UNFULFILLED,
    REFUNDED,
  ]),
  [CONFIRMING]: new Set([
    BRIDGING,
    SWAPPING,
    REFUNDING,
    PAUSED,
    DELIVERING,
    DELIVERED,
    FAILED,
    EXPIRED,
    REFUNDED,
  ]),
  [BRIDGING]: new Set([SWAPPING, PAUSED, DELIVERING, DELIVERED, FAILED, REFUNDED]),
  [SWAPPING]: new Set([
    AWAITING_APPROVAL,
    PAUSED,
    REFUNDING,
    BRIDGING,
    DELIVERING,
    DELIVERED,
    FAILED,
    REFUNDED,
  ]),
  [AWAITING_APPROVAL]: new Set([
    PROCESSING,
    CONFIRMING,
    SWAPPING,
    REFUNDING,
    PAUSED,
    FAILED,
    REFUNDED,
  ]),
  [PAUSED]: new Set([PROCESSING, FAILED]),
  [REFUNDING]: new Set([PAUSED, REFUNDED, FAILED]),
  [DELIVERING]: new Set([CONFIRMING, PAUSED, REFUNDING, DELIVERED, FAILED, REFUNDED]),
  [UNFULFILLED]: new Set([CONFIRMING, BRIDGING, SWAPPING, DELIVERING, DELIVERED]),

  // Terminal states — no outbound transitions.
  [DELIVERED]: new Set(),
  [FAILED]: new Set(),
  [EXPIRED]: new Set(),
  [REFUNDED]: new Set(),
}

/**
 * Validates a state transition.
 *
 * @returns The `next` state (unchanged) on a legal transition.
 * @throws  Error on any illegal transition (including terminal → anything).
 */
export function validateTransition(current: FlashnetOrderStatus, next: FlashnetOrderStatus): FlashnetOrderStatus {
  const allowed = ALLOWED_TRANSITIONS[current]
  if (!allowed) {
    throw new Error(`Unknown current state: "${current}"`)
  }
  if (!allowed.has(next)) {
    throw new Error(
      `Illegal state transition: "${current}" → "${next}". Allowed: [${[...allowed].join(', ') || 'none'}]`,
    )
  }
  return next
}

/**
 * Decision returned by `classifyTransition` — used by the webhook handler to
 * decide what to do with an incoming event without throwing on benign cases.
 *
 * - `apply`: legal forward transition; caller updates `FlashnetOrder.status`.
 * - `noop`:  redelivery of the same status (current === next); caller marks
 *           the webhook event processed and returns 204 without touching the
 *           order row. Common with Flashnet's at-least-once retry semantics.
 * - `skip`:  illegal transition (typically a stale / out-of-order delivery,
 *           e.g. `order.delivering` arriving after `DELIVERED`). Caller marks
 *           the webhook event processed and returns 204 to break Flashnet's
 *           retry loop. Logged at warn level so genuine bugs remain visible.
 */
export type TransitionDecision =
  | { kind: 'apply'; next: FlashnetOrderStatus }
  | { kind: 'noop'; reason: 'idempotent_redelivery' }
  | { kind: 'skip'; reason: 'stale_or_invalid'; allowed: FlashnetOrderStatus[] }

/**
 * Non-throwing classifier used by the webhook handler. Mirrors
 * `validateTransition` but never throws on a known current state — the
 * webhook handler must remain tolerant of duplicate and out-of-order
 * deliveries to avoid retry storms.
 *
 * Still throws on a truly unknown current state, since that signals a
 * programming error (e.g. a status string written to the DB by something
 * other than this state machine).
 */
export function classifyTransition(
  current: FlashnetOrderStatus,
  next: FlashnetOrderStatus,
): TransitionDecision {
  if (current === next) {
    return { kind: 'noop', reason: 'idempotent_redelivery' }
  }
  const allowed = ALLOWED_TRANSITIONS[current]
  if (!allowed) {
    throw new Error(`Unknown current state: "${current}"`)
  }
  if (!allowed.has(next)) {
    return { kind: 'skip', reason: 'stale_or_invalid', allowed: [...allowed] }
  }
  return { kind: 'apply', next }
}

/**
 * Maps a Flashnet webhook event name to a FlashnetOrder status string.
 *
 * Sourced from https://docs.flashnet.xyz/products/orchestration/api/webhook-events.
 * Flashnet event names (snake_case with "order." prefix) map to status values
 * (SCREAMING_SNAKE_CASE) stored in FlashnetOrder.status. The wire status
 * `completed` maps to our `DELIVERED` constant; every other name mirrors
 * the docs 1:1.
 */
export function mapEventToStatus(event: string): FlashnetOrderStatus {
  const mapping: Record<string, FlashnetOrderStatus> = {
    'order.processing': FLASHNET_ORDER_STATUS.PROCESSING,
    'order.confirming': FLASHNET_ORDER_STATUS.CONFIRMING,
    'order.bridging': FLASHNET_ORDER_STATUS.BRIDGING,
    'order.swapping': FLASHNET_ORDER_STATUS.SWAPPING,
    'order.awaiting_approval': FLASHNET_ORDER_STATUS.AWAITING_APPROVAL,
    'order.refunding': FLASHNET_ORDER_STATUS.REFUNDING,
    'order.delivering': FLASHNET_ORDER_STATUS.DELIVERING,
    'order.completed': FLASHNET_ORDER_STATUS.DELIVERED,
    'order.failed': FLASHNET_ORDER_STATUS.FAILED,
    'order.unfulfilled': FLASHNET_ORDER_STATUS.UNFULFILLED,
    'order.refunded': FLASHNET_ORDER_STATUS.REFUNDED,
  }

  const status = mapping[event]
  if (!status) {
    throw new Error(`Unknown Flashnet webhook event: "${event}"`)
  }
  return status
}
