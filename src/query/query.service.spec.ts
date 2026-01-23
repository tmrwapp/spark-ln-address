import { Test, TestingModule } from '@nestjs/testing'
import { Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { QueryService } from './query.service'
import { PrismaService } from '../prisma/prisma.service'
import { encodeSparkAddress } from '../common/spark-address.utils'

jest.mock('../common/spark-address.utils', () => {
  const actual = jest.requireActual('../common/spark-address.utils')
  return {
    ...actual,
    encodeSparkAddress: jest.fn(),
  }
})

describe('QueryService', () => {
  let service: QueryService

  const mockPrismaService = {
    lightningName: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
  }

  const mockConfigService = {
    get: jest.fn(),
  }

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueryService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile()

    service = module.get<QueryService>(QueryService)
    jest.clearAllMocks()
  })

  describe('findLightningNameByPubKey', () => {
    it('should find active lightning name by pubKey', async () => {
      const record = {
        id: 'ln-1',
        username: 'alice',
        userId: 'user-1',
        linkingPubKeyHex: '02'.padEnd(66, '0'),
        active: true,
      }

      mockPrismaService.lightningName.findFirst.mockResolvedValue(record)

      const result = await service.findLightningNameByPubKey(record.linkingPubKeyHex)

      expect(mockPrismaService.lightningName.findFirst).toHaveBeenCalledWith({
        where: {
          linkingPubKeyHex: record.linkingPubKeyHex,
          active: true,
        },
      })
      expect(result).toEqual(record)
    })

    it('should return null when no record found', async () => {
      mockPrismaService.lightningName.findFirst.mockResolvedValue(null)

      const result = await service.findLightningNameByPubKey('02'.padEnd(66, '1'))

      expect(result).toBeNull()
    })
  })

  describe('findLightningNameByUsername', () => {
    it('should normalize username and find active lightning names', async () => {
      const records = [
        {
          id: 'ln-1',
          username: 'alice',
          userId: 'user-1',
          linkingPubKeyHex: '02'.padEnd(66, '0'),
          active: true,
        },
      ]

      mockPrismaService.lightningName.findMany.mockResolvedValue(records)

      const result = await service.findLightningNameByUsername(' Alice ')

      expect(mockPrismaService.lightningName.findMany).toHaveBeenCalledWith({
        where: {
          username: {
            contains: 'alice',
          },
          active: true,
        },
      })
      expect(result).toEqual(records)
    })

    it('should return empty array when no matches found', async () => {
      mockPrismaService.lightningName.findMany.mockResolvedValue([])

      const result = await service.findLightningNameByUsername('bob')

      expect(result).toEqual([])
    })
  })

  describe('queryByPubKey', () => {
    it('should return response with encoded spark address', async () => {
      const record = {
        id: 'ln-1',
        username: 'alice',
        userId: 'user-1',
        linkingPubKeyHex: '02'.padEnd(66, '0'),
        active: true,
      }

      mockPrismaService.lightningName.findFirst.mockResolvedValue(record)
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'PUBLIC_BASE_URL') return 'https://example.com'
        if (key === 'SPARK_NETWORK') return 'TESTNET'
        return undefined
      })
      ;(encodeSparkAddress as jest.Mock).mockResolvedValue('sparkt1encoded')

      const result = await service.queryByPubKey(record.linkingPubKeyHex)

      expect(result).toEqual({
        username: 'alice',
        lightningAddress: 'alice@example.com',
        sparkAddress: 'sparkt1encoded',
        publicKey: record.linkingPubKeyHex,
      })
      expect(encodeSparkAddress).toHaveBeenCalledWith(record.linkingPubKeyHex, 'TESTNET')
    })

    it('should return null when lightning name not found', async () => {
      mockPrismaService.lightningName.findFirst.mockResolvedValue(null)

      const result = await service.queryByPubKey('02'.padEnd(66, '2'))

      expect(result).toBeNull()
    })

    it('should throw when PUBLIC_BASE_URL not configured', async () => {
      mockPrismaService.lightningName.findFirst.mockResolvedValue({
        id: 'ln-1',
        username: 'alice',
        userId: 'user-1',
        linkingPubKeyHex: '02'.padEnd(66, '0'),
        active: true,
      })
      mockConfigService.get.mockReturnValue(undefined)

      await expect(service.queryByPubKey('02'.padEnd(66, '0'))).rejects.toThrow(
        'PUBLIC_BASE_URL not configured',
      )
    })

    it('should handle spark address encoding errors gracefully', async () => {
      const record = {
        id: 'ln-1',
        username: 'alice',
        userId: 'user-1',
        linkingPubKeyHex: '02'.padEnd(66, '0'),
        active: true,
      }

      mockPrismaService.lightningName.findFirst.mockResolvedValue(record)
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'PUBLIC_BASE_URL') return 'https://example.com'
        return undefined
      })
      ;(encodeSparkAddress as jest.Mock).mockRejectedValue(new Error('bad key'))

      const result = await service.queryByPubKey(record.linkingPubKeyHex)

      expect(result).toEqual({
        username: 'alice',
        lightningAddress: 'alice@example.com',
        sparkAddress: '',
        publicKey: record.linkingPubKeyHex,
      })
      expect(Logger.prototype.error).toHaveBeenCalled()
    })
  })

  describe('queryByUsername', () => {
    it('should return responses for matching usernames', async () => {
      const records = [
        {
          id: 'ln-1',
          username: 'alice',
          userId: 'user-1',
          linkingPubKeyHex: '02'.padEnd(66, '0'),
          active: true,
        },
        {
          id: 'ln-2',
          username: 'alice2',
          userId: 'user-2',
          linkingPubKeyHex: '02'.padEnd(66, '1'),
          active: true,
        },
      ]

      mockPrismaService.lightningName.findMany.mockResolvedValue(records)
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'PUBLIC_BASE_URL') return 'https://example.com'
        if (key === 'SPARK_NETWORK') return 'MAINNET'
        return undefined
      })
      ;(encodeSparkAddress as jest.Mock)
        .mockResolvedValueOnce('spark1alice')
        .mockResolvedValueOnce('spark1alice2')

      const result = await service.queryByUsername('Alice')

      expect(result).toEqual([
        {
          username: 'alice',
          lightningAddress: 'alice@example.com',
          sparkAddress: 'spark1alice',
          publicKey: records[0].linkingPubKeyHex,
        },
        {
          username: 'alice2',
          lightningAddress: 'alice2@example.com',
          sparkAddress: 'spark1alice2',
          publicKey: records[1].linkingPubKeyHex,
        },
      ])
      expect(encodeSparkAddress).toHaveBeenCalledTimes(2)
    })

    it('should return empty array when no matches found', async () => {
      mockPrismaService.lightningName.findMany.mockResolvedValue([])

      const result = await service.queryByUsername('unknown')

      expect(result).toEqual([])
    })

    it('should throw when PUBLIC_BASE_URL not configured', async () => {
      mockPrismaService.lightningName.findMany.mockResolvedValue([
        {
          id: 'ln-1',
          username: 'alice',
          userId: 'user-1',
          linkingPubKeyHex: '02'.padEnd(66, '0'),
          active: true,
        },
      ])
      mockConfigService.get.mockReturnValue(undefined)

      await expect(service.queryByUsername('alice')).rejects.toThrow(
        'PUBLIC_BASE_URL not configured',
      )
    })

    it('should handle spark address encoding errors per item', async () => {
      const records = [
        {
          id: 'ln-1',
          username: 'alice',
          userId: 'user-1',
          linkingPubKeyHex: '02'.padEnd(66, '0'),
          active: true,
        },
        {
          id: 'ln-2',
          username: 'alice2',
          userId: 'user-2',
          linkingPubKeyHex: '02'.padEnd(66, '1'),
          active: true,
        },
      ]

      mockPrismaService.lightningName.findMany.mockResolvedValue(records)
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'PUBLIC_BASE_URL') return 'https://example.com'
        return undefined
      })
      ;(encodeSparkAddress as jest.Mock)
        .mockRejectedValueOnce(new Error('bad key'))
        .mockResolvedValueOnce('spark1alice2')

      const result = await service.queryByUsername('alice')

      expect(result).toEqual([
        {
          username: 'alice',
          lightningAddress: 'alice@example.com',
          sparkAddress: '',
          publicKey: records[0].linkingPubKeyHex,
        },
        {
          username: 'alice2',
          lightningAddress: 'alice2@example.com',
          sparkAddress: 'spark1alice2',
          publicKey: records[1].linkingPubKeyHex,
        },
      ])
      expect(Logger.prototype.error).toHaveBeenCalled()
    })
  })
})
