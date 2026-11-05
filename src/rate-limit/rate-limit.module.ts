import { Logger, Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import { NestExpressApplication } from '@nestjs/platform-express'
import { ThrottlerModule } from '@nestjs/throttler'
import { LnurlThrottlerGuard } from './rate-limit.guard'
import {
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_TRUST_PROXY,
  ROUTE_THROTTLER,
  ROUTE_THROTTLER_UNLIMITED,
} from './rate-limit.constants'

const logger = new Logger('RateLimitModule')

function positiveInt(raw: unknown, fallback: number, name: string): number {
  if (raw === undefined || raw === null || raw === '') {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    logger.warn({ event: 'rate_limit.invalid_config', name, fallback })
    return fallback
  }
  return value
}

/**
 * Rate limiting for every route (issue 30), with the in-memory store of
 * @nestjs/throttler. That store is process-local, which matches the single
 * PM2 instance in ecosystem.config.cjs; scaling out needs a shared store.
 *
 * Two throttlers run on every request:
 * - 'default': RATE_LIMIT_MAX requests per RATE_LIMIT_WINDOW_MS per client.
 * - 'route': unlimited unless a route sets a stricter @Throttle (see
 *   ROUTE_LIMITS).
 * RATE_LIMIT_ENABLED=false switches both off.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const enabled = config.get<string>('RATE_LIMIT_ENABLED') !== 'false'
        if (!enabled) {
          logger.warn({ event: 'rate_limit.disabled' })
        }
        return {
          skipIf: () => !enabled,
          throttlers: [
            {
              name: 'default',
              // One bucket per client across ALL routes (the library default
              // keys per route), so RATE_LIMIT_MAX is a true global cap.
              generateKey: (_context, tracker, name) => `${name}-${tracker}`,
              ttl: positiveInt(
                config.get('RATE_LIMIT_WINDOW_MS'),
                DEFAULT_RATE_LIMIT_WINDOW_MS,
                'RATE_LIMIT_WINDOW_MS',
              ),
              limit: positiveInt(
                config.get('RATE_LIMIT_MAX'),
                DEFAULT_RATE_LIMIT_MAX,
                'RATE_LIMIT_MAX',
              ),
            },
            {
              name: ROUTE_THROTTLER,
              ttl: DEFAULT_RATE_LIMIT_WINDOW_MS,
              limit: ROUTE_THROTTLER_UNLIMITED,
            },
          ],
        }
      },
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: LnurlThrottlerGuard }],
})
export class RateLimitModule {}

/**
 * Makes req.ip the real client behind NGINX. Without it every request carries
 * the proxy's address and all clients would share one bucket. Only proxies
 * matched by `value` (Express `trust proxy` syntax) may set X-Forwarded-For.
 */
export function configureTrustProxy(
  app: NestExpressApplication,
  value: string | undefined,
): void {
  let setting =
    value === undefined || value === '' ? DEFAULT_TRUST_PROXY : value
  if (setting.trim().toLowerCase() === 'true') {
    // Trusting every hop lets any client spoof X-Forwarded-For and pick its
    // own rate-limit bucket.
    logger.error({ event: 'rate_limit.trust_proxy_true_refused' })
    setting = DEFAULT_TRUST_PROXY
  }
  // A plain number is a hop count; Express needs it as a number, since the
  // string "1" would be read as an address.
  const effective =
    setting === 'false'
      ? false
      : /^\d+$/.test(setting.trim())
        ? Number(setting.trim())
        : setting
  app.set('trust proxy', effective)
  logger.log({ event: 'rate_limit.trust_proxy', setting: String(effective) })
}
