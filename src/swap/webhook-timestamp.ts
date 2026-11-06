/** Default tolerance between a webhook's timestamp and our clock: 5 minutes. */
export const DEFAULT_WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000

/** Largest tolerance FLASHNET_WEBHOOK_MAX_SKEW_MS may set: 1 hour. */
export const MAX_WEBHOOK_MAX_SKEW_MS = 60 * 60 * 1000

/** Values below this are read as Unix seconds, at or above as milliseconds. */
const MILLISECOND_THRESHOLD = 1e12

/**
 * True when `raw` is a plain decimal Unix timestamp (seconds or milliseconds)
 * within `maxSkewMs` of `nowMs`, in either direction.
 */
export function isFreshTimestamp(
  raw: string,
  nowMs: number,
  maxSkewMs: number,
): boolean {
  if (!/^\d{1,16}$/.test(raw)) {
    return false
  }
  const value = Number(raw)
  const ms = value < MILLISECOND_THRESHOLD ? value * 1000 : value
  return Math.abs(nowMs - ms) <= maxSkewMs
}
