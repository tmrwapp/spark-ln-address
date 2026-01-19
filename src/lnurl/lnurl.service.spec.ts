import { Test, TestingModule } from '@nestjs/testing'
import { LnurlService } from './lnurl.service'
import { PrismaService } from '../prisma/prisma.service'

describe('LnurlService', () => {
  let service: LnurlService
  let prismaService: PrismaService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LnurlService,
        {
          provide: PrismaService,
          useValue: {
            lightningName: {
              findFirst: jest.fn(),
            },
            invoice: {
              create: jest.fn(),
            },
          },
        },
      ],
    }).compile()

    service = module.get<LnurlService>(LnurlService)
    prismaService = module.get<PrismaService>(PrismaService)
  })

  it('should be defined', () => {
    expect(service).toBeDefined()
  })

  describe('findActiveLightningName', () => {
    it('should normalize username and find active lightning name', async () => {
      const mockLightningName = {
        id: '1',
        username: 'alice',
        userId: '1',
        linkingPubKeyHex: 'mock-key',
        active: true,
      }

      jest.spyOn(prismaService.lightningName, 'findFirst').mockResolvedValue({
        id: '1',
        username: 'alice',
        userId: '1',
        linkingPubKeyHex: 'mock-key',
        active: true,
      } as any)

      const result = await service.findActiveLightningName('Alice')

      expect(prismaService.lightningName.findFirst).toHaveBeenCalledWith({
        where: {
          username: 'alice',
          active: true,
        },
      })
      expect(result).toEqual(mockLightningName)
    })

    it('should return null if username not found', async () => {
      jest.spyOn(prismaService.lightningName, 'findFirst').mockResolvedValue(null)

      const result = await service.findActiveLightningName('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('createInvoice', () => {
    it('should create invoice with correct data', async () => {
      const invoiceData = {
        id: 'invoice-1',
        usernameId: 'user-1',
        amountMsat: BigInt(1000000),
        bolt11: 'lnbc10n1p...',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // Expire in 24 hours
        status: 'pending',
      }

      const mockInvoice = { id: 'invoice-1', ...invoiceData }

      jest.spyOn(prismaService.invoice, 'create').mockResolvedValue(mockInvoice)

      const result = await service.createInvoice(invoiceData)

      expect(prismaService.invoice.create).toHaveBeenCalledWith({
        data: invoiceData,
      })
      expect(result).toEqual(mockInvoice)
    })
  })
})





