import { Test, TestingModule } from '@nestjs/testing'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { RefundCaseService } from './refund-case.service'
import { PrismaService } from '../prisma/prisma.service'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRefundCase = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'rc_001',
  invoiceId: 'inv_001',
  amountSats: 5000,
  reason: 'delivery_failure',
  externalRef: null,
  payeeLnAddress: null,
  status: 'OPEN',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  resolvedAt: null,
  ...overrides,
})

// ---------------------------------------------------------------------------
// Mock PrismaService
// ---------------------------------------------------------------------------

const mockFindMany = jest.fn()
const mockCount = jest.fn()

const mockPrisma = {
  refundCase: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: mockFindMany,
    count: mockCount,
    update: jest.fn(),
  },
  $transaction: jest.fn(),
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RefundCaseService', () => {
  let service: RefundCaseService

  beforeEach(async () => {
    jest.clearAllMocks()

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefundCaseService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile()

    service = module.get<RefundCaseService>(RefundCaseService)
  })

  // -------------------------------------------------------------------------
  // createRefundCase
  // -------------------------------------------------------------------------

  describe('createRefundCase', () => {
    it('inserts a new RefundCase with status OPEN and returns it', async () => {
      const row = makeRefundCase()
      mockPrisma.refundCase.create.mockResolvedValue(row)

      const result = await service.createRefundCase({
        invoiceId: 'inv_001',
        amountSats: 5000,
        reason: 'delivery_failure',
      })

      expect(mockPrisma.refundCase.create).toHaveBeenCalledWith({
        data: {
          invoiceId: 'inv_001',
          amountSats: 5000,
          reason: 'delivery_failure',
          externalRef: undefined,
          status: 'OPEN',
        },
      })
      expect(result).toEqual(row)
    })

    it('propagates optional externalRef into the INSERT', async () => {
      const row = makeRefundCase({ externalRef: 'ext_abc' })
      mockPrisma.refundCase.create.mockResolvedValue(row)

      const result = await service.createRefundCase({
        invoiceId: 'inv_001',
        amountSats: 5000,
        reason: 'delivery_failure',
        externalRef: 'ext_abc',
      })

      expect(mockPrisma.refundCase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ externalRef: 'ext_abc' }),
      })
      expect(result.externalRef).toBe('ext_abc')
    })

    it('returns the existing row instead of throwing on P2002 unique-constraint violation', async () => {
      // Prisma 6 constructor: new PrismaClientKnownRequestError(message, { code, clientVersion, meta })
      // This is the correct Prisma 6 shape — clientVersion is a required string param.
      const uniqueError = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`invoiceId`)',
        { code: 'P2002', clientVersion: '6.18.0', meta: { target: ['invoiceId'] } },
      )
      const existingRow = makeRefundCase()
      mockPrisma.refundCase.create.mockRejectedValue(uniqueError)
      mockPrisma.refundCase.findUnique.mockResolvedValue(existingRow)

      const result = await service.createRefundCase({
        invoiceId: 'inv_001',
        amountSats: 5000,
        reason: 'delivery_failure',
      })

      // must NOT throw
      expect(mockPrisma.refundCase.findUnique).toHaveBeenCalledWith({
        where: { invoiceId: 'inv_001' },
      })
      expect(result).toEqual(existingRow)
    })

    it('re-throws non-P2002 Prisma errors', async () => {
      const otherError = new Prisma.PrismaClientKnownRequestError(
        'Foreign key constraint failed',
        { code: 'P2003', clientVersion: '6.18.0', meta: {} },
      )
      mockPrisma.refundCase.create.mockRejectedValue(otherError)

      await expect(
        service.createRefundCase({ invoiceId: 'inv_001', amountSats: 5000, reason: 'x' }),
      ).rejects.toThrow(otherError)
    })
  })

  // -------------------------------------------------------------------------
  // findById
  // -------------------------------------------------------------------------

  describe('findById', () => {
    it('returns the RefundCase when the id exists', async () => {
      const row = makeRefundCase()
      mockPrisma.refundCase.findUnique.mockResolvedValue(row)

      const result = await service.findById('rc_001')

      expect(mockPrisma.refundCase.findUnique).toHaveBeenCalledWith({ where: { id: 'rc_001' } })
      expect(result).toEqual(row)
    })

    it('returns null when the id does not exist', async () => {
      mockPrisma.refundCase.findUnique.mockResolvedValue(null)

      const result = await service.findById('nonexistent')

      expect(result).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // listOpenRefundCases
  // -------------------------------------------------------------------------

  describe('listOpenRefundCases', () => {
    beforeEach(() => {
      // Call-through: $transaction executes the array of promises passed to it.
      mockPrisma.$transaction.mockImplementation(
        (queries: Promise<unknown>[]) => Promise.all(queries),
      )
    })

    it('uses default limit=50 and skip=0 when called with no opts', async () => {
      mockFindMany.mockResolvedValue([])
      mockCount.mockResolvedValue(0)

      const result = await service.listOpenRefundCases()

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'OPEN' },
          orderBy: { createdAt: 'desc' },
          take: 50,
          skip: 0,
        }),
      )
      expect(result).toEqual({ data: [], total: 0 })
    })

    it('caps limit at 200 when caller passes limit: 500', async () => {
      const rows = [makeRefundCase()]
      mockFindMany.mockResolvedValue(rows)
      mockCount.mockResolvedValue(1)

      await service.listOpenRefundCases({ limit: 500, offset: 0 })

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 200 }),
      )
    })

    it('uses caller-provided limit and offset when within bounds', async () => {
      mockFindMany.mockResolvedValue([])
      mockCount.mockResolvedValue(0)

      await service.listOpenRefundCases({ limit: 25, offset: 10 })

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 25, skip: 10 }),
      )
    })

    it('returns data array and total from $transaction results', async () => {
      const rows = [makeRefundCase(), makeRefundCase({ id: 'rc_002' })]
      mockFindMany.mockResolvedValue(rows)
      mockCount.mockResolvedValue(42)

      const result = await service.listOpenRefundCases({ limit: 10, offset: 0 })

      expect(result.data).toEqual(rows)
      expect(result.total).toBe(42)
    })
  })

  // -------------------------------------------------------------------------
  // markPaid
  // -------------------------------------------------------------------------

  describe('markPaid', () => {
    it('sets status to PAID and resolvedAt on an OPEN case', async () => {
      const open = makeRefundCase({ status: 'OPEN' })
      const paid = makeRefundCase({ status: 'PAID', resolvedAt: new Date() })
      mockPrisma.refundCase.findUnique.mockResolvedValue(open)
      mockPrisma.refundCase.update.mockResolvedValue(paid)

      const result = await service.markPaid('rc_001', { externalRef: 'txn_abc' })

      expect(mockPrisma.refundCase.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'rc_001' },
          data: expect.objectContaining({
            status: 'PAID',
            externalRef: 'txn_abc',
          }),
        }),
      )
      expect(result.status).toBe('PAID')
    })

    it('records optional payeeLnAddress when provided', async () => {
      const open = makeRefundCase({ status: 'OPEN' })
      const paid = makeRefundCase({ status: 'PAID', resolvedAt: new Date(), payeeLnAddress: 'alice@example.com' })
      mockPrisma.refundCase.findUnique.mockResolvedValue(open)
      mockPrisma.refundCase.update.mockResolvedValue(paid)

      await service.markPaid('rc_001', { payeeLnAddress: 'alice@example.com' })

      expect(mockPrisma.refundCase.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ payeeLnAddress: 'alice@example.com' }),
        }),
      )
    })

    it('throws NotFoundException when id does not exist', async () => {
      mockPrisma.refundCase.findUnique.mockResolvedValue(null)

      await expect(service.markPaid('nonexistent', {})).rejects.toThrow(NotFoundException)
    })

    it('throws BadRequestException when status is not OPEN', async () => {
      mockPrisma.refundCase.findUnique.mockResolvedValue(
        makeRefundCase({ status: 'PAID' }),
      )

      await expect(service.markPaid('rc_001', {})).rejects.toThrow(BadRequestException)
    })

    it('works with no opts argument (uses default empty opts)', async () => {
      const open = makeRefundCase({ status: 'OPEN' })
      const paid = makeRefundCase({ status: 'PAID', resolvedAt: new Date() })
      mockPrisma.refundCase.findUnique.mockResolvedValue(open)
      mockPrisma.refundCase.update.mockResolvedValue(paid)

      const result = await service.markPaid('rc_001')

      expect(mockPrisma.refundCase.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'PAID' }) }),
      )
      expect(result.status).toBe('PAID')
    })
  })

  // -------------------------------------------------------------------------
  // markAbandoned
  // -------------------------------------------------------------------------

  describe('markAbandoned', () => {
    it('sets status to ABANDONED and resolvedAt on an OPEN case', async () => {
      const open = makeRefundCase({ status: 'OPEN' })
      const abandoned = makeRefundCase({ status: 'ABANDONED', resolvedAt: new Date() })
      mockPrisma.refundCase.findUnique.mockResolvedValue(open)
      mockPrisma.refundCase.update.mockResolvedValue(abandoned)

      const result = await service.markAbandoned('rc_001', { reason: 'no response' })

      expect(mockPrisma.refundCase.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'rc_001' },
          data: expect.objectContaining({
            status: 'ABANDONED',
            reason: 'no response',
          }),
        }),
      )
      expect(result.status).toBe('ABANDONED')
    })

    it('does NOT include reason in update data when no reason override is provided', async () => {
      const open = makeRefundCase({ status: 'OPEN', reason: 'original_reason' })
      const abandoned = makeRefundCase({ status: 'ABANDONED', resolvedAt: new Date(), reason: 'original_reason' })
      mockPrisma.refundCase.findUnique.mockResolvedValue(open)
      mockPrisma.refundCase.update.mockResolvedValue(abandoned)

      await service.markAbandoned('rc_001')

      const updateCall = mockPrisma.refundCase.update.mock.calls[0][0]
      // The data object must NOT contain a `reason` key when no override is supplied
      expect(updateCall.data).not.toHaveProperty('reason')
    })

    it('throws NotFoundException when id does not exist', async () => {
      mockPrisma.refundCase.findUnique.mockResolvedValue(null)

      await expect(service.markAbandoned('nonexistent', {})).rejects.toThrow(NotFoundException)
    })

    it('throws BadRequestException when status is not OPEN', async () => {
      mockPrisma.refundCase.findUnique.mockResolvedValue(
        makeRefundCase({ status: 'ABANDONED' }),
      )

      await expect(service.markAbandoned('rc_001', {})).rejects.toThrow(BadRequestException)
    })
  })
})
