import { Test, TestingModule } from '@nestjs/testing'
import { NotFoundException } from '@nestjs/common'
import { QueryController } from './query.controller'
import { QueryService } from './query.service'

describe('QueryController', () => {
  let controller: QueryController

  const mockQueryService = {
    queryByPubKey: jest.fn(),
    queryByUsername: jest.fn(),
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [QueryController],
      providers: [
        {
          provide: QueryService,
          useValue: mockQueryService,
        },
      ],
    }).compile()

    controller = module.get<QueryController>(QueryController)
    jest.clearAllMocks()
  })

  describe('queryByPubKey', () => {
    it('should return result when service finds a match', async () => {
      const response = {
        username: 'alice',
        lightningAddress: 'alice@example.com',
        sparkAddress: 'spark1alice',
        publicKey: '02'.padEnd(66, '0'),
      }

      mockQueryService.queryByPubKey.mockResolvedValue(response)

      const result = await controller.queryByPubKey('02'.padEnd(66, '0'))

      expect(mockQueryService.queryByPubKey).toHaveBeenCalledWith('02'.padEnd(66, '0'))
      expect(result).toEqual(response)
    })

    it('should throw NotFoundException when service returns null', async () => {
      mockQueryService.queryByPubKey.mockResolvedValue(null)

      await expect(controller.queryByPubKey('02'.padEnd(66, '1'))).rejects.toThrow(
        NotFoundException,
      )
      await expect(controller.queryByPubKey('02'.padEnd(66, '1'))).rejects.toMatchObject({
        message: 'No active username found for this public key',
      })
    })

    it('should surface service errors', async () => {
      mockQueryService.queryByPubKey.mockRejectedValue(new Error('failure'))

      await expect(controller.queryByPubKey('02'.padEnd(66, '2'))).rejects.toThrow('failure')
    })
  })

  describe('queryByUsername', () => {
    it('should return results from service', async () => {
      const response = [
        {
          username: 'alice',
          lightningAddress: 'alice@example.com',
          sparkAddress: 'spark1alice',
          publicKey: '02'.padEnd(66, '0'),
        },
      ]

      mockQueryService.queryByUsername.mockResolvedValue(response)

      const result = await controller.queryByUsername('alice')

      expect(mockQueryService.queryByUsername).toHaveBeenCalledWith('alice')
      expect(result).toEqual(response)
    })

    it('should return empty array when service returns empty array', async () => {
      mockQueryService.queryByUsername.mockResolvedValue([])

      const result = await controller.queryByUsername('unknown')

      expect(result).toEqual([])
    })

    it('should surface service errors', async () => {
      mockQueryService.queryByUsername.mockRejectedValue(new Error('failure'))

      await expect(controller.queryByUsername('alice')).rejects.toThrow('failure')
    })
  })
})
