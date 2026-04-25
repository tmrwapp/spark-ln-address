import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import * as request from 'supertest'
import { AppModule } from './../src/app.module'
import { PrismaService } from '../src/prisma/prisma.service'
import { getPublicKey, sign, hashes } from '@noble/secp256k1'
import { randomBytes, createHash, createHmac } from 'crypto'

// Set up @noble/secp256k1 hash functions for use in e2e signing helpers
hashes.sha256 = (m: Uint8Array) => createHash('sha256').update(m).digest()
hashes.hmacSha256 = (key: Uint8Array, ...ms: Uint8Array[]) => {
  const hmac = createHmac('sha256', key)
  ms.forEach((m) => hmac.update(m))
  return hmac.digest()
}

/**
 * Builds valid Spark signature request headers matching the canonical format
 * expected by SparkSignatureGuard.
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
  if (['POST', 'PATCH', 'PUT'].includes(method) && rawBody && rawBody.length > 0) {
    bodyHash = createHash('sha256').update(rawBody).digest('hex')
  }

  const canonicalMessage = `${method}:${url}:${timestamp}:${bodyHash}`
  const canonicalBytes = Buffer.from(canonicalMessage, 'utf8')

  const sigBytes = sign(canonicalBytes, privateKey)
  const signature = Buffer.from(sigBytes).toString('hex')
  const pubkey = Buffer.from(getPublicKey(privateKey, true)).toString('hex')

  return { pubkey, timestamp, signature, rawBody }
}

describe('AppController (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaService

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()

    app = moduleFixture.createNestApplication({ rawBody: true })
    prisma = moduleFixture.get<PrismaService>(PrismaService)
    await app.init()

    // Clean up database before each test
    await prisma.invoice.deleteMany()
    await prisma.lightningName.deleteMany()
    await prisma.user.deleteMany()
    await prisma.authNonce.deleteMany()
  })

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => {
        expect(res.body).toHaveProperty('status', 'ok')
        expect(res.body).toHaveProperty('timestamp')
      })
  })

  it('/.well-known/lnurlp/:username (GET) - username not found', () => {
    return request(app.getHttpServer())
      .get('/.well-known/lnurlp/nonexistent')
      .expect(404)
  })

  describe('AuthController (e2e)', () => {
    describe('GET /v1/auth/lnurl', () => {
      it('should return auth challenge with tag, k1, and callback', () => {
        return request(app.getHttpServer())
          .get('/v1/auth/lnurl')
          .expect(200)
          .expect((res) => {
            expect(res.body).toHaveProperty('tag', 'login')
            expect(res.body).toHaveProperty('k1')
            expect(res.body).toHaveProperty('callback')
            expect(res.body.k1).toMatch(/^[a-f0-9]{64}$/) // 32 bytes = 64 hex chars
            expect(res.body.callback).toContain('/v1/auth/lnurl/callback')
          })
      })

      it('should create a nonce in the database', async () => {
        const response = await request(app.getHttpServer())
          .get('/v1/auth/lnurl')
          .expect(200)

        const nonce = await prisma.authNonce.findUnique({
          where: { k1: response.body.k1 },
        })

        expect(nonce).toBeDefined()
        expect(nonce?.k1).toBe(response.body.k1)
        expect(nonce?.usedAt).toBeNull()
        expect(nonce?.expiresAt).toBeInstanceOf(Date)
      })

      it('should generate unique k1 values on each request', async () => {
        const response1 = await request(app.getHttpServer())
          .get('/v1/auth/lnurl')
          .expect(200)

        const response2 = await request(app.getHttpServer())
          .get('/v1/auth/lnurl')
          .expect(200)

        expect(response1.body.k1).not.toBe(response2.body.k1)
      })
    })

    describe('GET /v1/auth/lnurl/callback', () => {
      const validKey = '0'.repeat(66) // 66-char hex string (33 bytes)
      const validSig = '0'.repeat(128) // 128-char hex string (64 bytes)
      const validUsername = 'testuser'

      it('should successfully verify and bind username', async () => {
        // Generate a challenge first
        const challengeResponse = await request(app.getHttpServer())
          .get('/v1/auth/lnurl')
          .expect(200)

        const { k1 } = challengeResponse.body

        // Call the callback with valid parameters
        await request(app.getHttpServer())
          .get('/v1/auth/lnurl/callback')
          .query({ k1, sig: validSig, key: validKey, username: validUsername })
          .expect(200)
          .expect((res) => {
            expect(res.body).toHaveProperty('status', 'OK')
          })

        // Verify username was created
        const lightningName = await prisma.lightningName.findUnique({
          where: { username: validUsername },
        })

        expect(lightningName).toBeDefined()
        expect(lightningName?.username).toBe(validUsername)
        expect(lightningName?.linkingPubKeyHex).toBe(validKey)

        // Verify nonce was marked as used
        const nonce = await prisma.authNonce.findUnique({
          where: { k1 },
        })
        expect(nonce?.usedAt).toBeDefined()
      })

      it('should normalize username to lowercase', async () => {
        const challengeResponse = await request(app.getHttpServer())
          .get('/v1/auth/lnurl')
          .expect(200)

        const { k1 } = challengeResponse.body

        await request(app.getHttpServer())
          .get('/v1/auth/lnurl/callback')
          .query({ k1, sig: validSig, key: validKey, username: 'TestUser' })
          .expect(200)

        // Verify username was normalized
        const lightningName = await prisma.lightningName.findUnique({
          where: { username: 'testuser' },
        })

        expect(lightningName).toBeDefined()
        expect(lightningName?.username).toBe('testuser')
      })

      it('should return error for invalid k1', () => {
        return request(app.getHttpServer())
          .get('/v1/auth/lnurl/callback')
          .query({
            k1: 'invalid_k1_that_does_not_exist',
            sig: validSig,
            key: validKey,
            username: validUsername,
          })
          .expect(400)
          .expect((res) => {
            expect(res.body).toHaveProperty('status', 'ERROR')
            expect(res.body).toHaveProperty('reason', 'Invalid k1')
          })
      })

      it('should return error for already used k1', async () => {
        // Generate and use a challenge
        const challengeResponse = await request(app.getHttpServer())
          .get('/v1/auth/lnurl')
          .expect(200)

        const { k1 } = challengeResponse.body

        await request(app.getHttpServer())
          .get('/v1/auth/lnurl/callback')
          .query({ k1, sig: validSig, key: validKey, username: validUsername })
          .expect(200)

        // Try to use the same k1 again
        await request(app.getHttpServer())
          .get('/v1/auth/lnurl/callback')
          .query({
            k1,
            sig: validSig,
            key: '1'.repeat(66),
            username: 'anotheruser',
          })
          .expect(400)
          .expect((res) => {
            expect(res.body).toHaveProperty('status', 'ERROR')
            expect(res.body).toHaveProperty('reason', 'k1 already used')
          })
      })

      it('should return error for expired k1', async () => {
        // Generate a challenge
        const challengeResponse = await request(app.getHttpServer())
          .get('/v1/auth/lnurl')
          .expect(200)

        const { k1 } = challengeResponse.body

        // Manually expire the nonce
        await prisma.authNonce.update({
          where: { k1 },
          data: { expiresAt: new Date(Date.now() - 1000) }, // Expired 1 second ago
        })

        // Try to use the expired k1
        await request(app.getHttpServer())
          .get('/v1/auth/lnurl/callback')
          .query({ k1, sig: validSig, key: validKey, username: validUsername })
          .expect(400)
          .expect((res) => {
            expect(res.body).toHaveProperty('status', 'ERROR')
            expect(res.body).toHaveProperty('reason', 'k1 expired')
          })
      })

      it('should return error for invalid signature format', async () => {
        const challengeResponse = await request(app.getHttpServer())
          .get('/v1/auth/lnurl')
          .expect(200)

        const { k1 } = challengeResponse.body

        await request(app.getHttpServer())
          .get('/v1/auth/lnurl/callback')
          .query({
            k1,
            sig: 'invalid_sig', // Too short
            key: validKey,
            username: validUsername,
          })
          .expect(400)
          .expect((res) => {
            expect(res.body).toHaveProperty('status', 'ERROR')
            expect(res.body).toHaveProperty('reason', 'Invalid signature')
          })
      })

      it('should return error for invalid key format', async () => {
        const challengeResponse = await request(app.getHttpServer())
          .get('/v1/auth/lnurl')
          .expect(200)

        const { k1 } = challengeResponse.body

        await request(app.getHttpServer())
          .get('/v1/auth/lnurl/callback')
          .query({
            k1,
            sig: validSig,
            key: 'invalid_key', // Too short
            username: validUsername,
          })
          .expect(400)
          .expect((res) => {
            expect(res.body).toHaveProperty('status', 'ERROR')
            expect(res.body).toHaveProperty('reason', 'Invalid signature')
          })
      })

      it('should return error for username already taken', async () => {
        // Create a user and lightning name first
        const user = await prisma.user.create({ data: {} })
        await prisma.lightningName.create({
          data: {
            username: validUsername,
            userId: user.id,
            linkingPubKeyHex: '1'.repeat(66),
          },
        })

        const challengeResponse = await request(app.getHttpServer())
          .get('/v1/auth/lnurl')
          .expect(200)

        const { k1 } = challengeResponse.body

        await request(app.getHttpServer())
          .get('/v1/auth/lnurl/callback')
          .query({ k1, sig: validSig, key: validKey, username: validUsername })
          .expect(400)
          .expect((res) => {
            expect(res.body).toHaveProperty('status', 'ERROR')
            expect(res.body).toHaveProperty('reason', 'Username already taken')
          })
      })

      it('should return error when k1 is missing', () => {
        return request(app.getHttpServer())
          .get('/v1/auth/lnurl/callback')
          .query({ sig: validSig, key: validKey, username: validUsername })
          .expect(400)
      })

      it('should return error when sig is missing', async () => {
        const challengeResponse = await request(app.getHttpServer())
          .get('/v1/auth/lnurl')
          .expect(200)

        const { k1 } = challengeResponse.body

        return request(app.getHttpServer())
          .get('/v1/auth/lnurl/callback')
          .query({ k1, key: validKey, username: validUsername })
          .expect(400)
      })

      it('should return error when key is missing', async () => {
        const challengeResponse = await request(app.getHttpServer())
          .get('/v1/auth/lnurl')
          .expect(200)

        const { k1 } = challengeResponse.body

        return request(app.getHttpServer())
          .get('/v1/auth/lnurl/callback')
          .query({ k1, sig: validSig, username: validUsername })
          .expect(400)
      })

      it('should return error when username is missing', async () => {
        const challengeResponse = await request(app.getHttpServer())
          .get('/v1/auth/lnurl')
          .expect(200)

        const { k1 } = challengeResponse.body

        return request(app.getHttpServer())
          .get('/v1/auth/lnurl/callback')
          .query({ k1, sig: validSig, key: validKey })
          .expect(400)
      })
    })
  })

  describe('CurrencyPreferenceController (e2e)', () => {
    let privateKey: Uint8Array
    let pubkeyHex: string

    // Create a user + lightningName before each test in this suite
    beforeEach(async () => {
      privateKey = new Uint8Array(randomBytes(32))
      pubkeyHex = Buffer.from(getPublicKey(privateKey, true)).toString('hex')

      const user = await prisma.user.create({ data: {} })
      await prisma.lightningName.create({
        data: {
          username: 'currencytest',
          userId: user.id,
          linkingPubKeyHex: pubkeyHex,
        },
      })
    })

    describe('GET /v1/users/me/currency', () => {
      it('returns 401 without auth headers', () => {
        return request(app.getHttpServer())
          .get('/v1/users/me/currency')
          .expect(401)
      })

      it('returns current currency preference with valid auth headers', async () => {
        const { pubkey, timestamp, signature } = await buildValidRequest(privateKey, {
          method: 'GET',
          url: '/v1/users/me/currency',
        })

        return request(app.getHttpServer())
          .get('/v1/users/me/currency')
          .set('x-auth-pubkey', pubkey)
          .set('x-auth-timestamp', timestamp)
          .set('x-auth-signature', signature)
          .expect(200)
          .expect((res) => {
            expect(res.body).toHaveProperty('currency')
            expect(['SATS', 'USDB']).toContain(res.body.currency)
            expect(res.body).toHaveProperty('updatedAt')
          })
      })
    })

    describe('PATCH /v1/users/me/currency', () => {
      it('returns 401 without auth headers', () => {
        return request(app.getHttpServer())
          .patch('/v1/users/me/currency')
          .send({ currency: 'SATS' })
          .expect(401)
      })

      it('returns 400 with invalid enum value in body', async () => {
        const body = Buffer.from(JSON.stringify({ currency: 'BTC' }))
        const { pubkey, timestamp, signature } = await buildValidRequest(privateKey, {
          method: 'PATCH',
          url: '/v1/users/me/currency',
          rawBody: body,
        })

        return request(app.getHttpServer())
          .patch('/v1/users/me/currency')
          .set('x-auth-pubkey', pubkey)
          .set('x-auth-timestamp', timestamp)
          .set('x-auth-signature', signature)
          .set('content-type', 'application/json')
          .send({ currency: 'BTC' })
          .expect(400)
      })

      it('updates currency preference with valid auth and valid body', async () => {
        const body = Buffer.from(JSON.stringify({ currency: 'SATS' }))
        const { pubkey, timestamp, signature } = await buildValidRequest(privateKey, {
          method: 'PATCH',
          url: '/v1/users/me/currency',
          rawBody: body,
        })

        return request(app.getHttpServer())
          .patch('/v1/users/me/currency')
          .set('x-auth-pubkey', pubkey)
          .set('x-auth-timestamp', timestamp)
          .set('x-auth-signature', signature)
          .set('content-type', 'application/json')
          .send({ currency: 'SATS' })
          .expect(200)
          .expect((res) => {
            expect(res.body).toHaveProperty('currency', 'SATS')
            expect(res.body).toHaveProperty('updatedAt')
          })
      })

      it('body round-trips through the guard (rawBody populated correctly)', async () => {
        // This verifies the { rawBody: true } wiring in main.ts is effective:
        // the body hash must match for the signature to validate on PATCH.
        const body = Buffer.from(JSON.stringify({ currency: 'USDB' }))
        const { pubkey, timestamp, signature } = await buildValidRequest(privateKey, {
          method: 'PATCH',
          url: '/v1/users/me/currency',
          rawBody: body,
        })

        // The guard computes SHA-256 of req.rawBody and includes it in the canonical
        // message. If rawBody is absent, the hash is '' and the signature would fail.
        return request(app.getHttpServer())
          .patch('/v1/users/me/currency')
          .set('x-auth-pubkey', pubkey)
          .set('x-auth-timestamp', timestamp)
          .set('x-auth-signature', signature)
          .set('content-type', 'application/json')
          .send({ currency: 'USDB' })
          .expect(200)
          .expect((res) => {
            expect(res.body.currency).toBe('USDB')
          })
      })
    })
  })

  afterAll(async () => {
    await app.close()
  })
})
