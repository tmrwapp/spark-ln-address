import { Test, TestingModule } from '@nestjs/testing'
import { ExecutionContext, Logger, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { SparkSignatureGuard } from './spark-signature.guard'
import { PrismaService } from '../prisma/prisma.service'
import { getPublicKey, sign, hashes } from '@noble/secp256k1'
import { randomBytes, createHash, createHmac } from 'crypto'
import * as secp256k1Utils from './secp256k1.utils'

// Set up SHA-256 and HMAC-SHA256 for @noble/secp256k1 (used in buildValidRequest)
hashes.sha256 = (m: Uint8Array) => createHash('sha256').update(m).digest()
hashes.hmacSha256 = (key: Uint8Array, ...ms: Uint8Array[]) => {
  const hmac = createHmac('sha256', key)
  ms.forEach((m) => hmac.update(m))
  return hmac.digest()
}

// ── helpers ────────────────────────────────────────────────────────────────────

function makeContext(
  headers: Record<string, string | undefined>,
  opts?: {
    method?: string
    url?: string
    rawBody?: Buffer
  },
): ExecutionContext {
  const req = {
    headers,
    method: opts?.method ?? 'GET',
    originalUrl: opts?.url ?? '/v1/users/me/currency',
    rawBody: opts?.rawBody,
    user: undefined as any,
  }

  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Builds valid request headers + body that match what the guard expects.
 * Signatures are produced using the real @noble/secp256k1 library (imported at module level).
 */
async function buildValidRequest(
  privateKey: Uint8Array,
  opts?: {
    method?: string
    url?: string
    rawBody?: Buffer
    timestampOverride?: number
  },
): Promise<{
  pubkey: string
  timestamp: string
  signature: string
  rawBody?: Buffer
}> {
  const method = (opts?.method ?? 'GET').toUpperCase()
  const url = opts?.url ?? '/v1/users/me/currency'
  const timestamp = String(opts?.timestampOverride ?? Date.now())
  const rawBody = opts?.rawBody

  let bodyHash = ''
  if (
    ['POST', 'PATCH', 'PUT'].includes(method) &&
    rawBody &&
    rawBody.length > 0
  ) {
    bodyHash = sha256Hex(rawBody)
  }

  const canonicalMessage = `${method}:${url}:${timestamp}:${bodyHash}`
  const canonicalBytes = Buffer.from(canonicalMessage, 'utf8')

  const sigBytes = sign(canonicalBytes, privateKey)
  const signature = Buffer.from(sigBytes).toString('hex')
  const pubkey = Buffer.from(getPublicKey(privateKey, true)).toString('hex')

  return { pubkey, timestamp, signature, rawBody }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('SparkSignatureGuard', () => {
  let guard: SparkSignatureGuard
  let privateKey: Uint8Array
  let pubkeyHex: string

  // Mock verifySignature at module level — bypasses new Function() / Jest VM limitation.
  // The real crypto logic is covered by auth.service.spec.ts tests.
  const mockVerifySignature = jest.spyOn(secp256k1Utils, 'verifySignature')

  const mockUser = {
    id: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const mockLightningName = {
    id: 'ln-1',
    username: 'testuser',
    userId: 'user-1',
    linkingPubKeyHex: '',
    active: true,
    user: mockUser,
  }

  const mockPrismaService = {
    lightningName: {
      findFirst: jest.fn(),
    },
  }

  const mockConfigService = {
    get: jest.fn(),
  }

  beforeEach(async () => {
    privateKey = new Uint8Array(randomBytes(32))
    pubkeyHex = Buffer.from(getPublicKey(privateKey, true)).toString('hex')
    mockLightningName.linkingPubKeyHex = pubkeyHex

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SparkSignatureGuard,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile()

    guard = module.get<SparkSignatureGuard>(SparkSignatureGuard)

    jest.clearAllMocks()
    mockConfigService.get.mockReturnValue(undefined)
    mockPrismaService.lightningName.findFirst.mockResolvedValue(
      mockLightningName,
    )
    // Default: signature is valid
    mockVerifySignature.mockResolvedValue(true)
  })

  afterAll(() => {
    mockVerifySignature.mockRestore()
  })

  // ── happy path ──────────────────────────────────────────────────────────────

  it('valid signature → passes and populates request.user', async () => {
    const { pubkey, timestamp, signature } = await buildValidRequest(privateKey)

    const ctx = makeContext({
      'x-auth-pubkey': pubkey,
      'x-auth-timestamp': timestamp,
      'x-auth-signature': signature,
    })

    const result = await guard.canActivate(ctx)

    expect(result).toBe(true)
    expect(ctx.switchToHttp().getRequest().user).toEqual(mockUser)
    expect(mockPrismaService.lightningName.findFirst).toHaveBeenCalledWith({
      where: { linkingPubKeyHex: pubkey, active: true },
      include: { user: true },
    })
    expect(mockVerifySignature).toHaveBeenCalled()
  })

  // ── missing header(s) ───────────────────────────────────────────────────────

  it('missing x-auth-pubkey → 401', async () => {
    const { timestamp, signature } = await buildValidRequest(privateKey)

    const ctx = makeContext({
      'x-auth-timestamp': timestamp,
      'x-auth-signature': signature,
    })

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
    expect(mockVerifySignature).not.toHaveBeenCalled()
  })

  it('missing x-auth-timestamp → 401', async () => {
    const { pubkey, signature } = await buildValidRequest(privateKey)

    const ctx = makeContext({
      'x-auth-pubkey': pubkey,
      'x-auth-signature': signature,
    })

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
    expect(mockVerifySignature).not.toHaveBeenCalled()
  })

  it('missing x-auth-signature → 401', async () => {
    const { pubkey, timestamp } = await buildValidRequest(privateKey)

    const ctx = makeContext({
      'x-auth-pubkey': pubkey,
      'x-auth-timestamp': timestamp,
    })

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
    expect(mockVerifySignature).not.toHaveBeenCalled()
  })

  // ── timestamp skew ──────────────────────────────────────────────────────────

  it('timestamp skew > AUTH_MAX_SKEW_MS → 401', async () => {
    mockConfigService.get.mockReturnValue(60000)

    const pastTimestamp = Date.now() - 120000 // 2 minutes ago — exceeds 60s window
    const { pubkey, signature } = await buildValidRequest(privateKey, {
      timestampOverride: pastTimestamp,
    })

    const ctx = makeContext({
      'x-auth-pubkey': pubkey,
      'x-auth-timestamp': String(pastTimestamp),
      'x-auth-signature': signature,
    })

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
    expect(mockVerifySignature).not.toHaveBeenCalled()
  })

  it('timestamp within AUTH_MAX_SKEW_MS → passes', async () => {
    mockConfigService.get.mockReturnValue(60000)

    const nearTimestamp = Date.now() - 55000 // 55 seconds ago — within 60s window
    const { pubkey, signature } = await buildValidRequest(privateKey, {
      timestampOverride: nearTimestamp,
    })

    const ctx = makeContext({
      'x-auth-pubkey': pubkey,
      'x-auth-timestamp': String(nearTimestamp),
      'x-auth-signature': signature,
    })

    const result = await guard.canActivate(ctx)
    expect(result).toBe(true)
  })

  // ── invalid signature ───────────────────────────────────────────────────────

  it('invalid signature → 401', async () => {
    mockVerifySignature.mockResolvedValue(false)

    const { pubkey, timestamp } = await buildValidRequest(privateKey)
    const badSig = randomBytes(64).toString('hex')

    const ctx = makeContext({
      'x-auth-pubkey': pubkey,
      'x-auth-timestamp': timestamp,
      'x-auth-signature': badSig,
    })

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })

  // ── unknown pubkey ──────────────────────────────────────────────────────────

  it('unknown pubkey (no matching LightningName) → 401', async () => {
    mockPrismaService.lightningName.findFirst.mockResolvedValue(null)

    const { pubkey, timestamp, signature } = await buildValidRequest(privateKey)

    const ctx = makeContext({
      'x-auth-pubkey': pubkey,
      'x-auth-timestamp': timestamp,
      'x-auth-signature': signature,
    })

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })

  // ── body hash mismatch ──────────────────────────────────────────────────────

  it('body hash mismatch (POST with tampered body) → 401', async () => {
    // verifySignature returns false when the canonical message doesn't match
    mockVerifySignature.mockResolvedValue(false)

    const { pubkey, timestamp, signature } = await buildValidRequest(
      privateKey,
      {
        method: 'POST',
        rawBody: Buffer.from('{"currency":"SATS"}'),
      },
    )

    // Guard receives a different (tampered) body
    const ctx = makeContext(
      {
        'x-auth-pubkey': pubkey,
        'x-auth-timestamp': timestamp,
        'x-auth-signature': signature,
      },
      { method: 'POST', rawBody: Buffer.from('{"currency":"USDB"}') },
    )

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })

  // ── POST with matching body hash → passes ───────────────────────────────────

  it('valid POST with body → passes and populates request.user', async () => {
    const body = Buffer.from('{"currency":"SATS"}')
    const { pubkey, timestamp, signature } = await buildValidRequest(
      privateKey,
      {
        method: 'POST',
        rawBody: body,
      },
    )

    const ctx = makeContext(
      {
        'x-auth-pubkey': pubkey,
        'x-auth-timestamp': timestamp,
        'x-auth-signature': signature,
      },
      { method: 'POST', rawBody: body },
    )

    const result = await guard.canActivate(ctx)
    expect(result).toBe(true)
    expect(ctx.switchToHttp().getRequest().user).toEqual(mockUser)
  })

  // ── query string is part of the signed URL ─────────────────────────────────

  it('canonical message includes query string from originalUrl', async () => {
    const url = '/v1/things?q=A&sort=desc'
    const { pubkey, timestamp, signature } = await buildValidRequest(
      privateKey,
      { url },
    )

    const ctx = makeContext(
      {
        'x-auth-pubkey': pubkey,
        'x-auth-timestamp': timestamp,
        'x-auth-signature': signature,
      },
      { url },
    )

    await guard.canActivate(ctx)

    const passedBuffer = mockVerifySignature.mock.calls[0][0] as Buffer
    const passedMessage = passedBuffer.toString('utf8')
    expect(passedMessage).toBe(`GET:${url}:${timestamp}:`)
  })

  // ── replay protection ───────────────────────────────────────────────────────

  describe('replay protection', () => {
    it('rejects the same signature a second time', async () => {
      const { pubkey, timestamp, signature } =
        await buildValidRequest(privateKey)
      const headers = {
        'x-auth-pubkey': pubkey,
        'x-auth-timestamp': timestamp,
        'x-auth-signature': signature,
      }

      await expect(guard.canActivate(makeContext(headers))).resolves.toBe(true)
      await expect(guard.canActivate(makeContext(headers))).rejects.toThrow(
        UnauthorizedException,
      )
    })

    it('allows a fresh signature from the same pubkey', async () => {
      const first = await buildValidRequest(privateKey, {
        timestampOverride: Date.now() - 1000,
      })
      const second = await buildValidRequest(privateKey)

      await expect(
        guard.canActivate(
          makeContext({
            'x-auth-pubkey': first.pubkey,
            'x-auth-timestamp': first.timestamp,
            'x-auth-signature': first.signature,
          }),
        ),
      ).resolves.toBe(true)

      await expect(
        guard.canActivate(
          makeContext({
            'x-auth-pubkey': second.pubkey,
            'x-auth-timestamp': second.timestamp,
            'x-auth-signature': second.signature,
          }),
        ),
      ).resolves.toBe(true)
    })

    it('does not cache signatures that failed verification', async () => {
      const { pubkey, timestamp, signature } =
        await buildValidRequest(privateKey)
      const headers = {
        'x-auth-pubkey': pubkey,
        'x-auth-timestamp': timestamp,
        'x-auth-signature': signature,
      }

      mockVerifySignature.mockResolvedValueOnce(false)
      await expect(guard.canActivate(makeContext(headers))).rejects.toThrow(
        UnauthorizedException,
      )

      // Same request now verifies: it must be treated as first use, not a replay.
      await expect(guard.canActivate(makeContext(headers))).resolves.toBe(true)
    })

    it('rejects a replay of a state-changing PATCH', async () => {
      const rawBody = Buffer.from(JSON.stringify({ username: 'bob' }), 'utf8')
      const url = '/v1/users/me/username'
      const { pubkey, timestamp, signature } = await buildValidRequest(
        privateKey,
        {
          method: 'PATCH',
          url,
          rawBody,
        },
      )
      const headers = {
        'x-auth-pubkey': pubkey,
        'x-auth-timestamp': timestamp,
        'x-auth-signature': signature,
      }

      await expect(
        guard.canActivate(
          makeContext(headers, { method: 'PATCH', url, rawBody }),
        ),
      ).resolves.toBe(true)
      await expect(
        guard.canActivate(
          makeContext(headers, { method: 'PATCH', url, rawBody }),
        ),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('prunes remembered signatures once they fall outside the skew window', async () => {
      const first = await buildValidRequest(privateKey)

      await expect(
        guard.canActivate(
          makeContext({
            'x-auth-pubkey': first.pubkey,
            'x-auth-timestamp': first.timestamp,
            'x-auth-signature': first.signature,
          }),
        ),
      ).resolves.toBe(true)

      const cache = (
        guard as unknown as { seenSignatures: Map<string, number> }
      ).seenSignatures
      expect(cache.size).toBe(1)

      // A later request prunes what can no longer be replayed: past the skew
      // window the timestamp check rejects those on its own.
      const realNow = Date.now
      Date.now = () => realNow() + 61_000
      try {
        const later = await buildValidRequest(privateKey)
        await expect(
          guard.canActivate(
            makeContext({
              'x-auth-pubkey': later.pubkey,
              'x-auth-timestamp': later.timestamp,
              'x-auth-signature': later.signature,
            }),
          ),
        ).resolves.toBe(true)
      } finally {
        Date.now = realNow
      }

      expect(cache.size).toBe(1)
    })
  })

  // ── AUTH_MAX_SKEW_MS parsing (constructor-time) ─────────────────────────────

  describe('AUTH_MAX_SKEW_MS parsing', () => {
    async function buildGuardWith(raw: unknown): Promise<SparkSignatureGuard> {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SparkSignatureGuard,
          { provide: PrismaService, useValue: mockPrismaService },
          { provide: ConfigService, useValue: { get: () => raw } },
        ],
      }).compile()
      return module.get<SparkSignatureGuard>(SparkSignatureGuard)
    }

    async function skewFor(
      g: SparkSignatureGuard,
      tsOffsetMs: number,
    ): Promise<boolean> {
      const pk = new Uint8Array(randomBytes(32))
      const pkHex = Buffer.from(getPublicKey(pk, true)).toString('hex')
      mockLightningName.linkingPubKeyHex = pkHex
      const targetTs = Date.now() - tsOffsetMs
      const { pubkey, signature } = await buildValidRequest(pk, {
        timestampOverride: targetTs,
      })
      const ctx = makeContext({
        'x-auth-pubkey': pubkey,
        'x-auth-timestamp': String(targetTs),
        'x-auth-signature': signature,
      })
      try {
        return await g.canActivate(ctx)
      } catch {
        return false
      }
    }

    it('parses a numeric string env value', async () => {
      const g = await buildGuardWith('30000')
      // 25s ago → within 30s window → pass
      await expect(skewFor(g, 25_000)).resolves.toBe(true)
      // 35s ago → outside 30s window → fail
      await expect(skewFor(g, 35_000)).resolves.toBe(false)
    })

    it('falls back to default (60000) when env is undefined', async () => {
      const g = await buildGuardWith(undefined)
      // 55s ago → within default 60s window → pass
      await expect(skewFor(g, 55_000)).resolves.toBe(true)
      // 65s ago → outside default window → fail
      await expect(skewFor(g, 65_000)).resolves.toBe(false)
    })

    it('logs warning and falls back to default for non-numeric env value', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined)
      const g = await buildGuardWith('not-a-number')
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('AUTH_MAX_SKEW_MS="not-a-number"'),
      )
      // Default window still applies after the warning
      await expect(skewFor(g, 55_000)).resolves.toBe(true)
      warn.mockRestore()
    })

    it('logs warning and falls back to default for non-positive env value', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined)
      await buildGuardWith('0')
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('AUTH_MAX_SKEW_MS="0"'),
      )
      warn.mockRestore()
    })
  })
})
