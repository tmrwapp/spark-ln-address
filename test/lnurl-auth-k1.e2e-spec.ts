import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import * as request from 'supertest'
import { getPublicKey, sign, hashes } from '@noble/secp256k1'
import { randomBytes, createHash, createHmac } from 'crypto'
import { AppModule } from './../src/app.module'
import { PrismaService } from '../src/prisma/prisma.service'

hashes.sha256 = (m: Uint8Array) => createHash('sha256').update(m).digest()
hashes.hmacSha256 = (key: Uint8Array, ...ms: Uint8Array[]) => {
  const hmac = createHmac('sha256', key)
  ms.forEach((m) => hmac.update(m))
  return hmac.digest()
}

/**
 * Issue 33 against real MySQL: the single-use guarantee comes from InnoDB's
 * row lock on the conditional UPDATE, which the unit tests can only mock.
 */
describe('LNURL-auth k1 single use (e2e, issue 33)', () => {
  let app: INestApplication
  let prisma: PrismaService

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()

    app = moduleFixture.createNestApplication({ rawBody: true })
    prisma = moduleFixture.get<PrismaService>(PrismaService)
    await app.init()

    await prisma.invoice.deleteMany()
    await prisma.lightningName.deleteMany()
    await prisma.user.deleteMany()
    await prisma.authNonce.deleteMany()
  })

  afterEach(async () => {
    await app.close()
  })

  async function issueK1(): Promise<string> {
    const res = await request(app.getHttpServer()).get('/v1/auth/lnurl')
    expect(res.status).toBe(200)
    return res.body.k1 as string
  }

  function signK1(k1: string, privateKey: Uint8Array) {
    const sig = Buffer.from(sign(Buffer.from(k1, 'hex'), privateKey)).toString(
      'hex',
    )
    const key = Buffer.from(getPublicKey(privateKey, true)).toString('hex')
    return { sig, key }
  }

  function callback(k1: string, sig: string, key: string, username: string) {
    return request(app.getHttpServer())
      .get('/v1/auth/lnurl/callback')
      .query({ k1, sig, key, username })
  }

  it('lets exactly one of two concurrent callbacks with the same k1 succeed', async () => {
    const k1 = await issueK1()
    const first = signK1(k1, new Uint8Array(randomBytes(32)))
    const second = signK1(k1, new Uint8Array(randomBytes(32)))
    const suffix = randomBytes(3).toString('hex')

    const [a, b] = await Promise.all([
      callback(k1, first.sig, first.key, `race_a_${suffix}`),
      callback(k1, second.sig, second.key, `race_b_${suffix}`),
    ])

    const bodies = [a.body, b.body]
    expect(bodies.filter((body) => body.status === 'OK')).toHaveLength(1)
    expect(
      bodies.filter((body) => body.reason === 'k1 already used'),
    ).toHaveLength(1)
    expect(await prisma.lightningName.count()).toBe(1)
    const nonce = await prisma.authNonce.findUnique({ where: { k1 } })
    expect(nonce.usedAt).not.toBeNull()
  })

  it('rejects a sequential replay of a consumed k1', async () => {
    const k1 = await issueK1()
    const { sig, key } = signK1(k1, new Uint8Array(randomBytes(32)))
    const suffix = randomBytes(3).toString('hex')

    const ok = await callback(k1, sig, key, `once_${suffix}`)
    expect(ok.body).toEqual({ status: 'OK' })

    const replay = await callback(k1, sig, key, `twice_${suffix}`)
    expect(replay.status).toBe(400)
    expect(replay.body.reason).toBe('k1 already used')
  })

  it('leaves k1 unused when the name is taken, so the wallet can retry with another', async () => {
    const suffix = randomBytes(3).toString('hex')
    const taken = `taken_${suffix}`

    // Someone else holds the name.
    const otherK1 = await issueK1()
    const other = signK1(otherK1, new Uint8Array(randomBytes(32)))
    expect((await callback(otherK1, other.sig, other.key, taken)).body).toEqual(
      {
        status: 'OK',
      },
    )

    const k1 = await issueK1()
    const { sig, key } = signK1(k1, new Uint8Array(randomBytes(32)))

    const refused = await callback(k1, sig, key, taken)
    expect(refused.body.reason).toBe('Username already taken')
    const afterRefusal = await prisma.authNonce.findUnique({ where: { k1 } })
    expect(afterRefusal.usedAt).toBeNull()

    const retry = await callback(k1, sig, key, `free_${suffix}`)
    expect(retry.body).toEqual({ status: 'OK' })
  })
})
