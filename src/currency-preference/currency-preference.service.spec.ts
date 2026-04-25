import { Test, TestingModule } from '@nestjs/testing'
import { NotFoundException } from '@nestjs/common'
import { ReceivingCurrency } from '@prisma/client'
import { CurrencyPreferenceService } from './currency-preference.service'
import { PrismaService } from '../prisma/prisma.service'

describe('CurrencyPreferenceService', () => {
  let service: CurrencyPreferenceService

  const now = new Date('2026-04-22T00:00:00Z')

  const mockUser = {
    id: 'user-1',
    defaultReceivingCurrency: ReceivingCurrency.USDB,
    updatedAt: now,
  }

  const mockPrismaService = {
    user: {
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CurrencyPreferenceService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile()

    service = module.get<CurrencyPreferenceService>(CurrencyPreferenceService)
    jest.clearAllMocks()
  })

  describe('getPreference', () => {
    it('returns current currency and updatedAt', async () => {
      mockPrismaService.user.findUniqueOrThrow.mockResolvedValue({
        defaultReceivingCurrency: ReceivingCurrency.USDB,
        updatedAt: now,
      })

      const result = await service.getPreference('user-1')

      expect(result).toEqual({ currency: ReceivingCurrency.USDB, updatedAt: now })
      expect(mockPrismaService.user.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: { defaultReceivingCurrency: true, updatedAt: true },
      })
    })

    it('propagates error when user not found (findUniqueOrThrow throws)', async () => {
      mockPrismaService.user.findUniqueOrThrow.mockRejectedValue(
        new Error('No User found'),
      )

      await expect(service.getPreference('nonexistent')).rejects.toThrow('No User found')
    })
  })

  describe('setPreference', () => {
    it('persists new currency and returns updated record', async () => {
      const updatedAt = new Date('2026-04-22T01:00:00Z')
      mockPrismaService.user.update.mockResolvedValue({
        defaultReceivingCurrency: ReceivingCurrency.SATS,
        updatedAt,
      })

      const result = await service.setPreference('user-1', ReceivingCurrency.SATS)

      expect(result).toEqual({ currency: ReceivingCurrency.SATS, updatedAt })
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { defaultReceivingCurrency: ReceivingCurrency.SATS },
        select: { defaultReceivingCurrency: true, updatedAt: true },
      })
    })

    it('returns USDB when set to USDB', async () => {
      const updatedAt = new Date('2026-04-22T02:00:00Z')
      mockPrismaService.user.update.mockResolvedValue({
        defaultReceivingCurrency: ReceivingCurrency.USDB,
        updatedAt,
      })

      const result = await service.setPreference('user-1', ReceivingCurrency.USDB)

      expect(result).toEqual({ currency: ReceivingCurrency.USDB, updatedAt })
    })
  })
})
