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
 * Re-encodes a 64-byte compact signature as DER, preserving (r, s).
 *
 * verifySignature accepts both forms — it converts DER to compact at
 * secp256k1.utils.ts:109 — so this produces a different signature string that
 * verifies against the same message and key.
 */
function compactToDer(hex: string): string {
  const bytes = Buffer.from(hex, 'hex')
  const trim = (x: Buffer) => {
    let i = 0
    while (i < x.length - 1 && x[i] === 0) i++
    const v = x.subarray(i)
    return v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v
  }
  const r = trim(bytes.subarray(0, 32))
  const s = trim(bytes.subarray(32, 64))
  return Buffer.concat([
    Buffer.from([0x30, 4 + r.length + s.length, 0x02, r.length]),
    r,
    Buffer.from([0x02, s.length]),
    s,
  ]).toString('hex')
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
    // The cache only covers non-idempotent methods, so these exercise PATCH.
    // GET/HEAD exemption is covered in its own block below.
    const patchOpts = {
      method: 'PATCH',
      url: '/v1/users/me/username',
      rawBody: Buffer.from(JSON.stringify({ username: 'bob' }), 'utf8'),
    }

    it('rejects the same signature a second time', async () => {
      const { pubkey, timestamp, signature } = await buildValidRequest(
        privateKey,
        patchOpts,
      )
      const headers = {
        'x-auth-pubkey': pubkey,
        'x-auth-timestamp': timestamp,
        'x-auth-signature': signature,
      }

      await expect(
        guard.canActivate(makeContext(headers, patchOpts)),
      ).resolves.toBe(true)
      await expect(
        guard.canActivate(makeContext(headers, patchOpts)),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('rejects a replay re-encoded as a different signature string', async () => {
      // The cache must key on the request that was signed, not on the bytes of
      // the signature. verifySignature is deliberately tolerant — hex is decoded
      // case-insensitively and DER is converted to compact — so a captured
      // request can be re-encoded into a different signature string that still
      // verifies against the same message and key. Keying on that string lets
      // the same PATCH through as many times as there are valid encodings.
      const { pubkey, timestamp, signature } = await buildValidRequest(
        privateKey,
        patchOpts,
      )
      const headersWith = (sig: string) => ({
        'x-auth-pubkey': pubkey,
        'x-auth-timestamp': timestamp,
        'x-auth-signature': sig,
      })

      await expect(
        guard.canActivate(
          makeContext(headersWith(signature), patchOpts)
        ),
      ).resolves.toBe(true)

      // Same signature, uppercase hex
      await expect(
        guard.canActivate(
          makeContext(headersWith(signature.toUpperCase()), patchOpts),
        ),
      ).rejects.toThrow(UnauthorizedException)

      // Same signature, DER encoding
      await expect(
        guard.canActivate(
          makeContext(headersWith(compactToDer(signature)), patchOpts),
        ),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('allows a fresh signature from the same pubkey', async () => {
      const first = await buildValidRequest(privateKey, {
        ...patchOpts,
        timestampOverride: Date.now() - 1000,
      })
      const second = await buildValidRequest(privateKey, patchOpts)

      await expect(
        guard.canActivate(
          makeContext(
            {
              'x-auth-pubkey': first.pubkey,
              'x-auth-timestamp': first.timestamp,
              'x-auth-signature': first.signature,
            },
            patchOpts,
          ),
        ),
      ).resolves.toBe(true)

      await expect(
        guard.canActivate(
          makeContext(
            {
              'x-auth-pubkey': second.pubkey,
              'x-auth-timestamp': second.timestamp,
              'x-auth-signature': second.signature,
            },
            patchOpts,
          ),
        ),
      ).resolves.toBe(true)
    })

    it('does not cache signatures that failed verification', async () => {
      const { pubkey, timestamp, signature } = await buildValidRequest(
        privateKey,
        patchOpts,
      )
      const headers = {
        'x-auth-pubkey': pubkey,
        'x-auth-timestamp': timestamp,
        'x-auth-signature': signature,
      }

      mockVerifySignature.mockResolvedValueOnce(false)
      await expect(
        guard.canActivate(makeContext(headers, patchOpts)),
      ).rejects.toThrow(UnauthorizedException)

      // Same request now verifies: it must be treated as first use, not a replay.
      await expect(
        guard.canActivate(makeContext(headers, patchOpts)),
      ).resolves.toBe(true)
    })

    it('prunes remembered signatures once they fall outside the skew window', async () => {
      const first = await buildValidRequest(privateKey, patchOpts)

      await expect(
        guard.canActivate(
          makeContext(
            {
              'x-auth-pubkey': first.pubkey,
              'x-auth-timestamp': first.timestamp,
              'x-auth-signature': first.signature,
            },
            patchOpts,
          ),
        ),
      ).resolves.toBe(true)

      const cache = (
        guard as unknown as {
          seenSignatures: Map<string, Map<string, number>>
        }
      ).seenSignatures
      expect(cache.get(first.pubkey.toLowerCase()).size).toBe(1)

      // A later request prunes what can no longer be replayed: past the skew
      // window the timestamp check rejects those on its own.
      const realNow = Date.now
      Date.now = () => realNow() + 61_000
      try {
        const later = await buildValidRequest(privateKey, patchOpts)
        await expect(
          guard.canActivate(
            makeContext(
              {
                'x-auth-pubkey': later.pubkey,
                'x-auth-timestamp': later.timestamp,
                'x-auth-signature': later.signature,
              },
              patchOpts,
            ),
          ),
        ).resolves.toBe(true)
      } finally {
        Date.now = realNow
      }

      expect(cache.get(first.pubkey.toLowerCase()).size).toBe(1)
    })

    it('remembers a signature for as long as the skew check would admit it', async () => {
      // Client clock runs 59s fast. The skew check accepts the signature from
      // now until ts + 60s, so the cache has to hold it that long too —
      // expiring at acceptance + 60s would leave a window where the replay is
      // still admissible but no longer remembered.
      const base = Date.now()
      const req = await buildValidRequest(privateKey, {
        ...patchOpts,
        timestampOverride: base + 59_000,
      })
      const headers = {
        'x-auth-pubkey': req.pubkey,
        'x-auth-timestamp': req.timestamp,
        'x-auth-signature': req.signature,
      }

      await expect(
        guard.canActivate(makeContext(headers, patchOpts)),
      ).resolves.toBe(true)

      const realNow = Date.now
      Date.now = () => base + 61_000
      try {
        await expect(
          guard.canActivate(makeContext(headers, patchOpts)),
        ).rejects.toThrow(UnauthorizedException)
      } finally {
        Date.now = realNow
      }
    })

    it('does not cache signatures from a pubkey with no active name', async () => {
      const { pubkey, timestamp, signature } = await buildValidRequest(
        privateKey,
        patchOpts,
      )
      const headers = {
        'x-auth-pubkey': pubkey,
        'x-auth-timestamp': timestamp,
        'x-auth-signature': signature,
      }

      // A valid signature over a throwaway keypair verifies but resolves to no
      // user. Caching it would let anyone occupy the cache for free.
      mockPrismaService.lightningName.findFirst.mockResolvedValueOnce(null)
      await expect(
        guard.canActivate(makeContext(headers, patchOpts)),
      ).rejects.toThrow(UnauthorizedException)

      const cache = (
        guard as unknown as {
          seenSignatures: Map<string, Map<string, number>>
        }
      ).seenSignatures
      expect(cache.size).toBe(0)
    })

    it('rejects a pubkey that exceeds its own cache budget', async () => {
      // One over the cap: the last request has nowhere to be remembered, so it
      // must be refused rather than silently going unprotected. Timestamps are
      // taken from a fixed base so no two requests sign the same message.
      const base = Date.now()
      for (let i = 0; i < 200; i++) {
        const req = await buildValidRequest(privateKey, {
          ...patchOpts,
          timestampOverride: base - i,
        })
        await expect(
          guard.canActivate(
            makeContext(
              {
                'x-auth-pubkey': req.pubkey,
                'x-auth-timestamp': req.timestamp,
                'x-auth-signature': req.signature,
              },
              patchOpts,
            ),
          ),
        ).resolves.toBe(true)
      }

      const overflow = await buildValidRequest(privateKey, {
        ...patchOpts,
        timestampOverride: base - 200,
      })
      await expect(
        guard.canActivate(
          makeContext(
            {
              'x-auth-pubkey': overflow.pubkey,
              'x-auth-timestamp': overflow.timestamp,
              'x-auth-signature': overflow.signature,
            },
            patchOpts,
          ),
        ),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('does not let one pubkey flood another pubkey out of the cache', async () => {
      const victimKey = new Uint8Array(randomBytes(32))
      const victimPubkey = Buffer.from(getPublicKey(victimKey, true)).toString(
        'hex',
      )
      const victim = await buildValidRequest(victimKey, patchOpts)
      const victimHeaders = {
        'x-auth-pubkey': victim.pubkey,
        'x-auth-timestamp': victim.timestamp,
        'x-auth-signature': victim.signature,
      }

      // findFirst is keyed off the header, so both pubkeys resolve to a user.
      mockPrismaService.lightningName.findFirst.mockImplementation(
        ({ where }) => ({
          ...mockLightningName,
          linkingPubKeyHex: where.linkingPubKeyHex,
        }),
      )

      await expect(
        guard.canActivate(makeContext(victimHeaders, patchOpts)),
      ).resolves.toBe(true)

      // The attacker burns their whole budget; the victim's entry is in another
      // bucket and cannot be evicted by it.
      const base = Date.now()
      for (let i = 0; i < 200; i++) {
        const flood = await buildValidRequest(privateKey, {
          ...patchOpts,
          timestampOverride: base - i,
        })
        await guard
          .canActivate(
            makeContext(
              {
                'x-auth-pubkey': flood.pubkey,
                'x-auth-timestamp': flood.timestamp,
                'x-auth-signature': flood.signature,
              },
              patchOpts,
            ),
          )
          .catch(() => undefined)
      }

      await expect(
        guard.canActivate(makeContext(victimHeaders, patchOpts)),
      ).rejects.toThrow(UnauthorizedException)

      const cache = (
        guard as unknown as {
          seenSignatures: Map<string, Map<string, number>>
        }
      ).seenSignatures
      expect(cache.get(victimPubkey.toLowerCase()).size).toBe(1)
    })
  })

  // ── idempotent methods are exempt ───────────────────────────────────────────

  describe('replay exemption for idempotent methods', () => {
    it('lets an identical GET be sent twice', async () => {
      // A client retrying after a dropped response resends the request it
      // already signed. Rejecting that would surface as a 401 — which clients
      // read as bad credentials — for a read that changes nothing.
      const { pubkey, timestamp, signature } =
        await buildValidRequest(privateKey)
      const headers = {
        'x-auth-pubkey': pubkey,
        'x-auth-timestamp': timestamp,
        'x-auth-signature': signature,
      }

      await expect(guard.canActivate(makeContext(headers))).resolves.toBe(true)
      await expect(guard.canActivate(makeContext(headers))).resolves.toBe(true)
    })

    it('spends no cache budget on GET or HEAD', async () => {
      const get = await buildValidRequest(privateKey)
      await guard.canActivate(
        makeContext({
          'x-auth-pubkey': get.pubkey,
          'x-auth-timestamp': get.timestamp,
          'x-auth-signature': get.signature,
        }),
      )

      const head = await buildValidRequest(privateKey, { method: 'HEAD' })
      await guard.canActivate(
        makeContext(
          {
            'x-auth-pubkey': head.pubkey,
            'x-auth-timestamp': head.timestamp,
            'x-auth-signature': head.signature,
          },
          { method: 'HEAD' },
        ),
      )

      const cache = (
        guard as unknown as {
          seenSignatures: Map<string, Map<string, number>>
        }
      ).seenSignatures
      expect(cache.size).toBe(0)
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
