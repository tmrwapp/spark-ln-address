import { Logger } from '@nestjs/common'
import { AuthNoncePurgeService } from './auth-nonce-purge.service'

describe('AuthNoncePurgeService (issue 30)', () => {
  const prisma = {
    authNonce: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  }
  let service: AuthNoncePurgeService

  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    service = new AuthNoncePurgeService(prisma as never)
  })

  afterEach(() => {
    service.onModuleDestroy()
    jest.restoreAllMocks()
  })

  it('deletes only nonces that expired before the grace cutoff', async () => {
    prisma.authNonce.findMany.mockResolvedValueOnce([
      { id: 'n1' },
      { id: 'n2' },
    ])
    prisma.authNonce.deleteMany.mockResolvedValueOnce({ count: 2 })

    const now = new Date('2026-11-05T12:00:00Z')
    const deleted = await service.purgeExpired(now)

    expect(deleted).toBe(2)
    const where = prisma.authNonce.findMany.mock.calls[0][0].where
    expect(where.expiresAt.lt.getTime()).toBeLessThanOrEqual(now.getTime())
    expect(prisma.authNonce.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['n1', 'n2'] } },
    })
  })

  it('drains a large backlog in bounded batches', async () => {
    const batch = Array.from({ length: 1000 }, (_, i) => ({ id: `n${i}` }))
    prisma.authNonce.findMany
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce([{ id: 'last' }])
    prisma.authNonce.deleteMany
      .mockResolvedValueOnce({ count: 1000 })
      .mockResolvedValueOnce({ count: 1000 })
      .mockResolvedValueOnce({ count: 1 })

    const deleted = await service.purgeExpired(new Date())

    expect(deleted).toBe(2001)
    expect(prisma.authNonce.findMany).toHaveBeenCalledTimes(3)
    expect(prisma.authNonce.findMany.mock.calls[0][0].take).toBe(1000)
  })

  it('does nothing when no nonce has expired', async () => {
    prisma.authNonce.findMany.mockResolvedValueOnce([])

    await expect(service.purgeExpired(new Date())).resolves.toBe(0)
    expect(prisma.authNonce.deleteMany).not.toHaveBeenCalled()
  })

  it('does not schedule itself under the test runner', () => {
    const spy = jest.spyOn(global, 'setInterval')
    service.onModuleInit()
    expect(spy).not.toHaveBeenCalled()
  })

  it('schedules the purge outside tests, and a failed run is logged, not thrown', async () => {
    const originalEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    jest.useFakeTimers()
    try {
      prisma.authNonce.findMany.mockRejectedValue(new Error('db down'))
      service.onModuleInit()
      await jest.advanceTimersByTimeAsync(30 * 1000)
      expect(prisma.authNonce.findMany).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000)
      expect(prisma.authNonce.findMany).toHaveBeenCalled()
      expect(Logger.prototype.warn).toHaveBeenCalled()
    } finally {
      service.onModuleDestroy()
      jest.useRealTimers()
      process.env.NODE_ENV = originalEnv
    }
  })
})
