import { DEFAULT_IPV6_SUBNET_PREFIX, normalizeIp } from '@nestjs/throttler'

/** Longest name segment kept in a tracker key; real names are at most 30. */
const MAX_NAME_IN_KEY = 32

/**
 * Tracker for the LNURL-pay callback: the client (IPv6 collapsed to its /64,
 * like the default tracker) plus the requested name, lowercased and cut, so
 * `Alice` and `alice` share a bucket and a long name cannot bloat the store.
 */
export function payerAndNameTracker(req: Record<string, any>): string {
  const client = normalizeIp(String(req.ip ?? ''), DEFAULT_IPV6_SUBNET_PREFIX)
  const name = String(req.params?.username ?? '')
    .trim()
    .toLowerCase()
    .slice(0, MAX_NAME_IN_KEY)
  return `${client}:${name}`
}
