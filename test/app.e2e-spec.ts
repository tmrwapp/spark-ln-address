import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import * as request from 'supertest'
import { AppModule } from './../src/app.module'
import { PrismaService } from '../src/prisma/prisma.service'

describe('AppController (e2e)', () => {
  let app: INestApplication
  let prisma: PrismaService

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()

    app = moduleFixture.createNestApplication()
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

  afterAll(async () => {
    await app.close()
  })
})
