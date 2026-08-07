import { Test, TestingModule } from '@nestjs/testing'
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { UsernameService } from './username.service'
import { PrismaService } from '../prisma/prisma.service'

const PUBKEY =
  '02698ba4177fb9e15109be413711938cc19a6790010f39bb82f180e221f7607166'

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ln-alice',
    username: 'alice',
    userId: 'user-1',
    linkingPubKeyHex: PUBKEY,
    active: true,
    activePubKey: PUBKEY,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  }
}

/** Prisma unique-constraint error shape, as the service checks it structurally. */
function uniqueViolation(target: string) {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target },
  })
}

describe('UsernameService', () => {
  let service: UsernameService

  const tx = {
    lightningName: {
      update: jest.fn(),
      create: jest.fn(),
    },
  }

  const mockPrismaService = {
    lightningName: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    user: {
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  }

  const mockConfigService = {
    get: jest.fn(),
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsernameService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile()

    service = module.get<UsernameService>(UsernameService)

    jest.clearAllMocks()
    mockConfigService.get.mockReturnValue('https://guap.to')
    mockPrismaService.user.findUniqueOrThrow.mockResolvedValue({
      bonusUsernameChanges: 0,
    })
    mockPrismaService.lightningName.findUnique.mockResolvedValue(null)
    mockPrismaService.$transaction.mockImplementation(
      async (cb: (t: unknown) => unknown) => cb(tx),
    )
  })

  describe('getUsernameInfo', () => {
    it('returns the active name, address, quota and full history', async () => {
      mockPrismaService.lightningName.findMany.mockResolvedValue([
        makeRow({ id: 'ln-bob', username: 'bob' }),
        makeRow({
          id: 'ln-alice',
          username: 'alice',
          active: false,
          activePubKey: null,
        }),
      ])

      const result = await service.getUsernameInfo('user-1')

      expect(result).toEqual({
        username: 'bob',
        lightningAddress: 'bob@guap.to',
        changesUsed: 1,
        changesLimit: 2,
        changesRemaining: 1,
        history: [
          {
            username: 'bob',
            active: true,
            claimedAt: new Date('2026-06-01T00:00:00Z'),
          },
          {
            username: 'alice',
            active: false,
            claimedAt: new Date('2026-06-01T00:00:00Z'),
          },
        ],
      })
    })

    it('reports a raised ceiling when support has granted extra changes', async () => {
      mockPrismaService.lightningName.findMany.mockResolvedValue([makeRow()])
      mockPrismaService.user.findUniqueOrThrow.mockResolvedValue({
        bonusUsernameChanges: 3,
      })

      const result = await service.getUsernameInfo('user-1')

      expect(result.changesLimit).toBe(5)
      expect(result.changesRemaining).toBe(5)
      expect(result.changesUsed).toBe(0)
    })

    it('throws when the account has no active name', async () => {
      mockPrismaService.lightningName.findMany.mockResolvedValue([
        makeRow({ active: false, activePubKey: null }),
      ])

      await expect(service.getUsernameInfo('user-1')).rejects.toThrow(
        NotFoundException,
      )
    })
  })

  describe('changeUsername — claiming a new name', () => {
    beforeEach(() => {
      mockPrismaService.lightningName.findMany.mockResolvedValue([makeRow()])
    })

    it('retires the old name and creates the new one', async () => {
      const result = await service.changeUsername('user-1', 'bob')

      expect(tx.lightningName.update).toHaveBeenCalledWith({
        where: { id: 'ln-alice' },
        data: { active: false, activePubKey: null },
      })
      expect(tx.lightningName.create).toHaveBeenCalledWith({
        data: {
          username: 'bob',
          userId: 'user-1',
          linkingPubKeyHex: PUBKEY,
          active: true,
          activePubKey: PUBKEY,
        },
      })
      expect(result).toEqual({
        username: 'bob',
        lightningAddress: 'bob@guap.to',
        changesUsed: 1,
        changesLimit: 2,
        changesRemaining: 1,
        switchedBack: false,
      })
    })

    it('deactivates before activating, so the activePubKey index is never doubled', async () => {
      const order: string[] = []
      tx.lightningName.update.mockImplementation(async () => {
        order.push('update')
      })
      tx.lightningName.create.mockImplementation(async () => {
        order.push('create')
      })

      await service.changeUsername('user-1', 'bob')

      expect(order).toEqual(['update', 'create'])
    })

    it('normalizes the requested name before using it', async () => {
      await service.changeUsername('user-1', '  BOB  ')

      expect(tx.lightningName.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ username: 'bob' }),
        }),
      )
    })

    it('rejects a name that is active under another account', async () => {
      mockPrismaService.lightningName.findUnique.mockResolvedValue(
        makeRow({ id: 'ln-other', username: 'bob', userId: 'user-2' }),
      )

      await expect(
        service.changeUsername('user-1', 'bob'),
      ).rejects.toMatchObject({
        response: { code: 'USERNAME_TAKEN' },
      })
      expect(mockPrismaService.$transaction).not.toHaveBeenCalled()
    })

    it('rejects a name that another account has retired', async () => {
      mockPrismaService.lightningName.findUnique.mockResolvedValue(
        makeRow({
          id: 'ln-other',
          username: 'bob',
          userId: 'user-2',
          active: false,
          activePubKey: null,
        }),
      )

      await expect(service.changeUsername('user-1', 'bob')).rejects.toThrow(
        ConflictException,
      )
    })

    it('maps a losing race on the username index to USERNAME_TAKEN', async () => {
      mockPrismaService.$transaction.mockRejectedValue(
        uniqueViolation('username'),
      )

      await expect(
        service.changeUsername('user-1', 'bob'),
      ).rejects.toMatchObject({
        response: { code: 'USERNAME_TAKEN' },
      })
    })

    it('does not disguise an activePubKey violation as a taken username', async () => {
      mockPrismaService.$transaction.mockRejectedValue(
        uniqueViolation('activePubKey'),
      )

      await expect(
        service.changeUsername('user-1', 'bob'),
      ).rejects.not.toBeInstanceOf(ConflictException)
    })

    it('rejects the current name', async () => {
      await expect(
        service.changeUsername('user-1', 'alice'),
      ).rejects.toMatchObject({
        response: { code: 'SAME_USERNAME' },
      })
    })

    it('rejects a name that fails the format rules', async () => {
      await expect(
        service.changeUsername('user-1', 'Not Valid!'),
      ).rejects.toMatchObject({
        response: { code: 'INVALID_USERNAME' },
      })
      expect(mockPrismaService.$transaction).not.toHaveBeenCalled()
    })

    it('rejects a name longer than 30 characters', async () => {
      await expect(
        service.changeUsername('user-1', 'a'.repeat(31)),
      ).rejects.toThrow(BadRequestException)
    })
  })

  describe('changeUsername — quota', () => {
    const spentRows = [
      makeRow({ id: 'ln-carol', username: 'carol' }),
      makeRow({
        id: 'ln-alice',
        username: 'alice',
        active: false,
        activePubKey: null,
      }),
      makeRow({
        id: 'ln-bob',
        username: 'bob',
        active: false,
        activePubKey: null,
      }),
    ]

    it('rejects a third new name once the default allowance is spent', async () => {
      mockPrismaService.lightningName.findMany.mockResolvedValue(spentRows)

      await expect(
        service.changeUsername('user-1', 'dave'),
      ).rejects.toMatchObject({
        response: { code: 'CHANGE_LIMIT_REACHED' },
      })
      expect(mockPrismaService.$transaction).not.toHaveBeenCalled()
    })

    it('still allows switching back after the allowance is spent', async () => {
      mockPrismaService.lightningName.findMany.mockResolvedValue(spentRows)

      const result = await service.changeUsername('user-1', 'bob')

      expect(result.switchedBack).toBe(true)
      expect(result.changesRemaining).toBe(0)
    })

    it('allows a third new name when support has granted one', async () => {
      mockPrismaService.lightningName.findMany.mockResolvedValue(spentRows)
      mockPrismaService.user.findUniqueOrThrow.mockResolvedValue({
        bonusUsernameChanges: 1,
      })

      const result = await service.changeUsername('user-1', 'dave')

      expect(result).toMatchObject({
        username: 'dave',
        changesUsed: 3,
        changesLimit: 3,
        changesRemaining: 0,
        switchedBack: false,
      })
    })
  })

  describe('changeUsername — switching back', () => {
    it('re-activates an owned name without consuming quota', async () => {
      mockPrismaService.lightningName.findMany.mockResolvedValue([
        makeRow({ id: 'ln-bob', username: 'bob' }),
        makeRow({
          id: 'ln-alice',
          username: 'alice',
          active: false,
          activePubKey: null,
        }),
      ])

      const result = await service.changeUsername('user-1', 'alice')

      expect(tx.lightningName.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'ln-bob' },
        data: { active: false, activePubKey: null },
      })
      expect(tx.lightningName.update).toHaveBeenNthCalledWith(2, {
        where: { id: 'ln-alice' },
        data: { active: true, activePubKey: PUBKEY },
      })
      expect(tx.lightningName.create).not.toHaveBeenCalled()
      expect(result).toMatchObject({
        username: 'alice',
        changesUsed: 1,
        changesRemaining: 1,
        switchedBack: true,
      })
    })

    it('does not run the availability probe for an owned name', async () => {
      mockPrismaService.lightningName.findMany.mockResolvedValue([
        makeRow({ id: 'ln-bob', username: 'bob' }),
        makeRow({
          id: 'ln-alice',
          username: 'alice',
          active: false,
          activePubKey: null,
        }),
      ])

      await service.changeUsername('user-1', 'alice')

      expect(mockPrismaService.lightningName.findUnique).not.toHaveBeenCalled()
    })
  })

  describe('grantExtraChanges', () => {
    it('raises the ceiling and returns the refreshed quota', async () => {
      mockPrismaService.lightningName.findFirst.mockResolvedValue(makeRow())
      mockPrismaService.lightningName.findMany.mockResolvedValue([makeRow()])
      mockPrismaService.user.findUniqueOrThrow.mockResolvedValue({
        bonusUsernameChanges: 1,
      })

      const result = await service.grantExtraChanges(
        PUBKEY,
        1,
        'typo at registration',
      )

      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { bonusUsernameChanges: { increment: 1 } },
      })
      expect(result).toMatchObject({ changesLimit: 3, changesRemaining: 3 })
    })

    it('looks the user up by the lowercased pubkey', async () => {
      mockPrismaService.lightningName.findFirst.mockResolvedValue(makeRow())
      mockPrismaService.lightningName.findMany.mockResolvedValue([makeRow()])

      await service.grantExtraChanges(
        PUBKEY.toUpperCase(),
        1,
        'support request',
      )

      expect(mockPrismaService.lightningName.findFirst).toHaveBeenCalledWith({
        where: { linkingPubKeyHex: PUBKEY, active: true },
      })
    })

    it('throws for an unknown pubkey and grants nothing', async () => {
      mockPrismaService.lightningName.findFirst.mockResolvedValue(null)

      await expect(
        service.grantExtraChanges(PUBKEY, 1, 'support request'),
      ).rejects.toThrow(NotFoundException)
      expect(mockPrismaService.user.update).not.toHaveBeenCalled()
    })
  })
})
