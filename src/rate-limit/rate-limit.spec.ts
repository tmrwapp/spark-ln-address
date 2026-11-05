import { INestApplication, Logger } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import * as request from 'supertest'
import { AuthController } from '../auth/auth.controller'
import { AuthService } from '../auth/auth.service'
import { LnurlController } from '../lnurl/lnurl.controller'
import { LnurlService } from '../lnurl/lnurl.service'
import { LightsparkService } from '../lightspark/lightspark.service'
import { SwapService } from '../swap/swap.service'
import { FlashnetWebhookController } from '../swap/flashnet-webhook.controller'
import { PrismaService } from '../prisma/prisma.service'
import { FLASHNET_SERVICE } from '../flashnet/flashnet.module'
import { AppController } from '../app.controller'
import { RateLimitModule, configureTrustProxy } from './rate-limit.module'
import { ROUTE_LIMITS } from './rate-limit.constants'

/**
 * One test per abuse path from issue 30. Each builds a real Nest app with the
 * production RateLimitModule, so the global guard, the per-route overrides and
 * the LNURL error shape are exercised end to end over HTTP.
 */
describe('rate limiting (issue 30)', () => {
  let app: INestApplication
  const authService = {
    generateAuthChallenge: jest.fn(async () => ({
      k1: 'a'.repeat(64),
      callback: 'https://example.com/v1/auth/lnurl/callback',
    })),
    verifyAndBindUsername: jest.fn(async () => ({ status: 'OK' })),
  }
  const lnurlService = {
    findActiveLightningNameWithUser: jest.fn(async () => null),
    findActiveLightningName: jest.fn(async () => null),
  }

  async function boot(
    env: Record<string, string> = {},
    trustProxy = 'loopback',
  ) {
    const saved = { ...process.env }
    Object.assign(process.env, env)
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        RateLimitModule,
      ],
      controllers: [
        AuthController,
        LnurlController,
        FlashnetWebhookController,
        AppController,
      ],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: LnurlService, useValue: lnurlService },
        { provide: LightsparkService, useValue: {} },
        { provide: SwapService, useValue: { applyWebhookEvent: jest.fn() } },
        { provide: PrismaService, useValue: {} },
        {
          provide: FLASHNET_SERVICE,
          useValue: { verifyWebhookSignature: () => false },
        },
      ],
    }).compile()
    process.env = saved

    const nestApp = moduleRef.createNestApplication<NestExpressApplication>()
    configureTrustProxy(nestApp, trustProxy)
    await nestApp.init()
    return nestApp
  }

  async function hit(
    path: string,
    times: number,
    forwardedFor = '203.0.113.7',
  ) {
    const statuses: number[] = []
    let last: request.Response | undefined
    for (let i = 0; i < times; i++) {
      last = await request(app.getHttpServer())
        .get(path)
        .set('X-Forwarded-For', forwardedFor)
      statuses.push(last.status)
    }
    return { statuses, last }
  }

  afterEach(async () => {
    await app?.close()
    jest.clearAllMocks()
  })

  it('caps k1 issuance so one client cannot flood auth_nonces', async () => {
    app = await boot()
    const { limit } = ROUTE_LIMITS.authChallenge

    const { statuses, last } = await hit('/v1/auth/lnurl', limit + 1)

    expect(statuses.slice(0, limit).every((s) => s === 200)).toBe(true)
    expect(statuses[limit]).toBe(429)
    expect(authService.generateAuthChallenge).toHaveBeenCalledTimes(limit)
    // LUD-04 wallets read the error from the body.
    expect(last.body).toEqual({
      status: 'ERROR',
      reason: 'Too many requests, retry later',
    })
    const retryAfter = Number(last.headers['retry-after'])
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(60)
  })

  it('caps registration attempts on the auth callback', async () => {
    app = await boot()
    const { limit } = ROUTE_LIMITS.authCallback
    const path =
      '/v1/auth/lnurl/callback?k1=' +
      'a'.repeat(64) +
      '&sig=ab&key=02&username=x'

    const { statuses } = await hit(path, limit + 1)

    expect(statuses[limit]).toBe(429)
    expect(authService.verifyAndBindUsername).toHaveBeenCalledTimes(limit)
  })

  it('caps invoice and quote creation on the LNURL-pay callback per payer and name', async () => {
    app = await boot()
    const { limit } = ROUTE_LIMITS.lnurlCallback

    const { statuses } = await hit(
      '/lnurl/callback/alice?amount=1000',
      limit + 1,
    )

    expect(statuses[limit]).toBe(429)
    expect(lnurlService.findActiveLightningNameWithUser).toHaveBeenCalledTimes(
      limit,
    )
  })

  it('keys the LNURL-pay limit by name, so one payer can still pay other users', async () => {
    app = await boot()
    const { limit } = ROUTE_LIMITS.lnurlCallback
    await hit('/lnurl/callback/alice?amount=1000', limit + 1)

    const { statuses } = await hit('/lnurl/callback/bob?amount=1000', 1)

    expect(statuses[0]).not.toBe(429)
  })

  it('tracks clients behind the proxy separately (X-Forwarded-For from a trusted proxy)', async () => {
    app = await boot()
    const { limit } = ROUTE_LIMITS.authChallenge
    await hit('/v1/auth/lnurl', limit + 1, '203.0.113.7')

    const { statuses } = await hit('/v1/auth/lnurl', 1, '198.51.100.9')

    expect(statuses[0]).toBe(200)
  })

  it('applies the global per-client limit from RATE_LIMIT_MAX to every other route', async () => {
    app = await boot({ RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' })

    const { statuses } = await hit('/.well-known/lnurlp/alice', 4)

    expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true)
    expect(statuses[3]).toBe(429)
  })

  it('shares one LNURL-pay bucket across case variants of a name', async () => {
    app = await boot()
    const { limit } = ROUTE_LIMITS.lnurlCallback
    const variants = ['alice', 'Alice', 'ALICE', ' alice']
    const statuses: number[] = []
    for (let i = 0; i <= limit; i++) {
      const name = encodeURIComponent(variants[i % variants.length])
      const res = await request(app.getHttpServer())
        .get(`/lnurl/callback/${name}?amount=1000`)
        .set('X-Forwarded-For', '203.0.113.7')
      statuses.push(res.status)
    }

    expect(statuses[limit]).toBe(429)
  })

  it('collapses IPv6 clients to their /64, so address rotation does not reset the limit', async () => {
    app = await boot()
    const { limit } = ROUTE_LIMITS.authChallenge
    const statuses: number[] = []
    for (let i = 0; i <= limit; i++) {
      const res = await request(app.getHttpServer())
        .get('/v1/auth/lnurl')
        .set('X-Forwarded-For', `2001:db8:1:2::${(i + 1).toString(16)}`)
      statuses.push(res.status)
    }

    expect(statuses[limit]).toBe(429)
  })

  it('counts the global limit across routes, not per route', async () => {
    app = await boot({ RATE_LIMIT_MAX: '4' })

    await hit('/.well-known/lnurlp/alice', 2)
    await hit('/v1/auth/lnurl', 2)
    const { statuses } = await hit('/lnurl/callback/bob?amount=1000', 1)

    expect(statuses[0]).toBe(429)
  })

  it('ignores X-Forwarded-For from an untrusted peer, so it cannot be spoofed', async () => {
    app = await boot({}, 'false')
    const { limit } = ROUTE_LIMITS.authChallenge
    const statuses: number[] = []
    for (let i = 0; i <= limit; i++) {
      const res = await request(app.getHttpServer())
        .get('/v1/auth/lnurl')
        .set('X-Forwarded-For', `198.51.100.${i + 1}`)
      statuses.push(res.status)
    }

    expect(statuses[limit]).toBe(429)
  })

  it('refuses TRUST_PROXY=true and falls back to the default', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined)
    app = await boot({}, 'true')

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'rate_limit.trust_proxy_true_refused' }),
    )
    error.mockRestore()
  })

  it('falls back to the default limit when RATE_LIMIT_MAX is invalid', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined)
    app = await boot({ RATE_LIMIT_MAX: 'lots' })

    const { statuses } = await hit('/.well-known/lnurlp/alice', 5)

    expect(statuses.every((s) => s !== 429)).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'rate_limit.invalid_config' }),
    )
    warn.mockRestore()
  })

  it('never throttles the Flashnet webhook or the health check', async () => {
    app = await boot({ RATE_LIMIT_MAX: '1' })

    for (let i = 0; i < 3; i++) {
      const res = await request(app.getHttpServer())
        .post('/v1/internal/flashnet/webhook')
        .set('X-Forwarded-For', '203.0.113.7')
        .send({})
      expect(res.status).not.toBe(429)
    }
    const { statuses } = await hit('/health', 3)
    expect(statuses.every((s) => s !== 429)).toBe(true)
  })

  it('can be switched off with RATE_LIMIT_ENABLED=false', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    app = await boot({ RATE_LIMIT_ENABLED: 'false' })
    const { limit } = ROUTE_LIMITS.authChallenge

    const { statuses } = await hit('/v1/auth/lnurl', limit + 2)

    expect(statuses.every((s) => s === 200)).toBe(true)
  })
})
