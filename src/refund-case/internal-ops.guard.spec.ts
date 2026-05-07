import { ExecutionContext, Logger, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { timingSafeEqual } from 'crypto'
import { InternalOpsGuard } from './internal-ops.guard'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeContext = (authHeader: string | undefined): ExecutionContext => {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: authHeader !== undefined ? { authorization: authHeader } : {},
      }),
    }),
  } as unknown as ExecutionContext
}

const makeGuard = (tokenEnvValue: string | undefined) => {
  const configService = {
    get: jest.fn().mockReturnValue(tokenEnvValue),
  } as unknown as ConfigService
  return new InternalOpsGuard(configService)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InternalOpsGuard', () => {
  describe('when INTERNAL_OPS_TOKEN is configured', () => {
    const SECRET = 'super-secret-ops-token'
    let guard: InternalOpsGuard

    beforeEach(() => {
      guard = makeGuard(SECRET)
    })

    it('passes a request bearing the correct Bearer token', () => {
      const ctx = makeContext(`Bearer ${SECRET}`)
      expect(guard.canActivate(ctx)).toBe(true)
    })

    it('rejects a request with a correct-length but wrong-value token (timingSafeEqual path)', () => {
      // Build a token of identical byte length to SECRET but different content
      const sameLength = 'A'.repeat(Buffer.byteLength(SECRET, 'utf8'))
      const ctx = makeContext(`Bearer ${sameLength}`)
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
    })

    it('rejects a request with a wrong-length token (length check path, not timingSafeEqual)', () => {
      const ctx = makeContext('Bearer short')
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
    })

    it('rejects a request with no Authorization header', () => {
      const ctx = makeContext(undefined)
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
    })

    it('rejects a request with wrong scheme — Token prefix', () => {
      const ctx = makeContext(`Token ${SECRET}`)
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
    })

    it('rejects a request with wrong scheme — Basic prefix', () => {
      const ctx = makeContext(`Basic dXNlcjpwYXNz`)
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
    })

    it('rejects a "Bearer " header with no token value following it', () => {
      // "Bearer " with nothing after — slice(7) produces an empty string
      const ctx = makeContext('Bearer ')
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
    })

    it('uses timingSafeEqual (not ===) for token comparison', () => {
      // Spy on the real timingSafeEqual via the crypto module binding
      const spy = jest.spyOn(
        require('crypto') as typeof import('crypto'),
        'timingSafeEqual',
      )

      const sameLength = 'A'.repeat(Buffer.byteLength(SECRET, 'utf8'))
      const ctx = makeContext(`Bearer ${sameLength}`)

      try {
        guard.canActivate(ctx)
      } catch {
        // expected to throw — we only care about the spy
      }

      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })
  })

  describe('when INTERNAL_OPS_TOKEN is empty / unset', () => {
    it('rejects every request when token is empty string and logs a warning', () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn')

      const guard = makeGuard('')
      const ctx = makeContext('Bearer anything')

      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('INTERNAL_OPS_TOKEN is empty or unset'),
      )

      warnSpy.mockRestore()
    })

    it('rejects every request when token is undefined and logs a warning', () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn')

      const guard = makeGuard(undefined)
      const ctx = makeContext('Bearer anything')

      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('INTERNAL_OPS_TOKEN is empty or unset'),
      )

      warnSpy.mockRestore()
    })
  })
})
