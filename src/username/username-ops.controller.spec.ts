import { Test, TestingModule } from '@nestjs/testing'
import { NotFoundException, ValidationPipe } from '@nestjs/common'
import * as request from 'supertest'
import { UsernameOpsController } from './username-ops.controller'
import { UsernameService } from './username.service'
import { InternalOpsGuard } from '../refund-case/internal-ops.guard'

const PUBKEY =
  '02698ba4177fb9e15109be413711938cc19a6790010f39bb82f180e221f7607166'

const info = {
  username: 'carol',
  lightningAddress: 'carol@guap.to',
  changesUsed: 2,
  changesLimit: 3,
  changesRemaining: 1,
  history: [{ username: 'carol', active: true, claimedAt: new Date(0) }],
}

const mockService = {
  getUsernameInfoByPubKey: jest.fn(),
  grantExtraChanges: jest.fn(),
}

// Auth itself is covered by internal-ops.guard.spec.ts. What matters here is
// that THIS controller is behind that guard at all, so the guard is switched
// per test rather than permanently bypassed.
const allow = { canActivate: jest.fn().mockReturnValue(true) }
const deny = { canActivate: jest.fn().mockReturnValue(false) }

async function buildApp(guard: { canActivate: jest.Mock }) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [UsernameOpsController],
    providers: [
      { provide: UsernameService, useValue: mockService },
      { provide: InternalOpsGuard, useValue: guard },
    ],
  })
    .overrideGuard(InternalOpsGuard)
    .useValue(guard)
    .compile()

  const app = module.createNestApplication()
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  )
  await app.init()
  return app
}

describe('UsernameOpsController', () => {
  let app: any

  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
  })

  describe('GET :pubkey', () => {
    it('reads the quota without touching the grant', async () => {
      // The reason this endpoint exists: a grant cannot be revoked, so an
      // operator must be able to look before acting.
      mockService.getUsernameInfoByPubKey.mockResolvedValue(info)
      app = await buildApp(allow)

      const response = await request(app.getHttpServer())
        .get(`/v1/internal/username-changes/${PUBKEY}`)
        .set('Authorization', 'Bearer test')

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        username: 'carol',
        changesLimit: 3,
      })
      expect(mockService.getUsernameInfoByPubKey).toHaveBeenCalledWith(PUBKEY)
      expect(mockService.grantExtraChanges).not.toHaveBeenCalled()
    })

    it('is behind the ops guard', async () => {
      // Not a test of the guard's logic — a test that this controller is
      // covered by it. An unguarded operator read would expose one customer's
      // name history to anyone who can reach the service.
      app = await buildApp(deny)

      const response = await request(app.getHttpServer()).get(
        `/v1/internal/username-changes/${PUBKEY}`,
      )

      expect(response.status).toBe(403)
      expect(mockService.getUsernameInfoByPubKey).not.toHaveBeenCalled()
    })

    it('surfaces an unknown pubkey as 404', async () => {
      mockService.getUsernameInfoByPubKey.mockRejectedValue(
        new NotFoundException('No active username found for this public key'),
      )
      app = await buildApp(allow)

      const response = await request(app.getHttpServer())
        .get(`/v1/internal/username-changes/${PUBKEY}`)
        .set('Authorization', 'Bearer test')

      expect(response.status).toBe(404)
    })
  })

  describe('route separation', () => {
    it('the read and the grant do not collide', async () => {
      // `GET :pubkey` sits next to `POST :pubkey/grant`. A path that swallowed
      // the other would either 404 the read or turn a read into a write.
      mockService.getUsernameInfoByPubKey.mockResolvedValue(info)
      mockService.grantExtraChanges.mockResolvedValue(info)
      app = await buildApp(allow)

      await request(app.getHttpServer())
        .post(`/v1/internal/username-changes/${PUBKEY}/grant`)
        .set('Authorization', 'Bearer test')
        .send({ amount: 1, reason: 'typo at registration' })
        .expect(201)

      expect(mockService.grantExtraChanges).toHaveBeenCalledWith(
        PUBKEY,
        1,
        'typo at registration',
      )
      expect(mockService.getUsernameInfoByPubKey).not.toHaveBeenCalled()
    })

    it('a GET on the grant path is not a route at all', async () => {
      app = await buildApp(allow)

      await request(app.getHttpServer())
        .get(`/v1/internal/username-changes/${PUBKEY}/grant`)
        .set('Authorization', 'Bearer test')
        .expect(404)

      expect(mockService.getUsernameInfoByPubKey).not.toHaveBeenCalled()
    })
  })

  describe('POST :pubkey/grant', () => {
    it('still rejects a body the DTO does not allow', async () => {
      // The read must not have loosened the write's validation.
      app = await buildApp(allow)

      await request(app.getHttpServer())
        .post(`/v1/internal/username-changes/${PUBKEY}/grant`)
        .set('Authorization', 'Bearer test')
        .send({ amount: -1, reason: 'take one back' })
        .expect(400)

      expect(mockService.grantExtraChanges).not.toHaveBeenCalled()
    })
  })
})
