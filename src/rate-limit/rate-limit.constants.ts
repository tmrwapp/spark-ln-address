/**
 * Per-route limits (issue 30), applied on top of the global per-client limit
 * (RATE_LIMIT_MAX per RATE_LIMIT_WINDOW_MS). All windows are one minute.
 */
export const ROUTE_WINDOW_MS = 60_000

export const ROUTE_LIMITS = {
  /** GET /v1/auth/lnurl: each call inserts an auth_nonces row. */
  authChallenge: { limit: 30, ttl: ROUTE_WINDOW_MS },
  /** GET /v1/auth/lnurl/callback: registration attempts. */
  authCallback: { limit: 10, ttl: ROUTE_WINDOW_MS },
  /**
   * GET /lnurl/callback/:username: each call creates an invoice and possibly a
   * Flashnet quote. Keyed by client AND name, so a custodial wallet paying many
   * different users from one IP is not throttled as a whole.
   */
  lnurlCallback: { limit: 30, ttl: ROUTE_WINDOW_MS },
  /** PATCH /v1/users/me/username: signed, but not idempotent. */
  usernameChange: { limit: 10, ttl: ROUTE_WINDOW_MS },
} as const

/** Name of the per-route throttler; the global one is 'default'. */
export const ROUTE_THROTTLER = 'route'

/** Defaults for the global per-client throttler. */
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000
export const DEFAULT_RATE_LIMIT_MAX = 600

/** The per-route throttler is a no-op on routes that do not override it. */
export const ROUTE_THROTTLER_UNLIMITED = Number.MAX_SAFE_INTEGER

/**
 * Express `trust proxy` default: the proxies on this host or a private network
 * (NGINX in front of the app). req.ip is then the client from X-Forwarded-For.
 */
export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal'
