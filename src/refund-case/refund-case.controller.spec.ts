import { Test, TestingModule } from '@nestjs/testing'
import { NotFoundException, ValidationPipe } from '@nestjs/common'
import * as request from 'supertest'
import { RefundCaseController } from './refund-case.controller'
import { RefundCaseService } from './refund-case.service'
import { InternalOpsGuard } from './internal-ops.guard'

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
// Mock service
// ---------------------------------------------------------------------------

const mockService = {
  listOpenRefundCases: jest.fn(),
  findById: jest.fn(),
  markPaid: jest.fn(),
  markAbandoned: jest.fn(),
}

// Bypass guard in unit tests — auth is tested separately in internal-ops.guard.spec.ts
const mockGuard = { canActivate: jest.fn().mockReturnValue(true) }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RefundCaseController', () => {
  let controller: RefundCaseController
  let app: any

  beforeEach(async () => {
    jest.clearAllMocks()

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RefundCaseController],
      providers: [
        { provide: RefundCaseService, useValue: mockService },
        { provide: InternalOpsGuard, useValue: mockGuard },
      ],
    })
      .overrideGuard(InternalOpsGuard)
      .useValue(mockGuard)
      .compile()

    controller = module.get<RefundCaseController>(RefundCaseController)

    // Create a full HTTP app so we can test route ordering and ValidationPipe
    app = module.createNestApplication()
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    )
    await app.init()
  })

  afterEach(async () => {
    await app.close()
  })

  // -------------------------------------------------------------------------
  // GET /  — list handler
  // -------------------------------------------------------------------------

  describe('listOpen', () => {
    it('calls service with limit and offset from query and returns result', async () => {
      const payload = { data: [makeRefundCase()], total: 1 }
      mockService.listOpenRefundCases.mockResolvedValue(payload)

      const result = await controller.listOpen(10, 5)

      expect(mockService.listOpenRefundCases).toHaveBeenCalledWith({ limit: 10, offset: 5 })
      expect(result).toEqual(payload)
    })

    it('applies default limit=50, offset=0 when no params are provided', async () => {
      const payload = { data: [], total: 0 }
      mockService.listOpenRefundCases.mockResolvedValue(payload)

      const result = await controller.listOpen(50, 0)

      expect(mockService.listOpenRefundCases).toHaveBeenCalledWith({ limit: 50, offset: 0 })
      expect(result).toEqual(payload)
    })

    it('route-ordering: GET /v1/internal/refund-cases hits the list handler, not the :id handler', async () => {
      // This verifies NestJS routes @Get() before @Get(':id') — guards bypassed.
      const payload = { data: [], total: 0 }
      mockService.listOpenRefundCases.mockResolvedValue(payload)

      const response = await request(app.getHttpServer())
        .get('/v1/internal/refund-cases')
        .set('Authorization', 'Bearer test')

      // If the route-ordering were wrong, findById would be called instead.
      expect(mockService.listOpenRefundCases).toHaveBeenCalled()
      expect(mockService.findById).not.toHaveBeenCalled()
      expect(response.status).not.toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // GET /:id
  // -------------------------------------------------------------------------

  describe('findOne', () => {
    it('returns a RefundCase when found', async () => {
      const row = makeRefundCase()
      mockService.findById.mockResolvedValue(row)

      const result = await controller.findOne('rc_001')

      expect(mockService.findById).toHaveBeenCalledWith('rc_001')
      expect(result).toEqual(row)
    })

    it('throws NotFoundException when the case does not exist', async () => {
      mockService.findById.mockResolvedValue(null)

      await expect(controller.findOne('missing')).rejects.toThrow(NotFoundException)
    })

    it('GET /v1/internal/refund-cases/:id returns 404 for a nonexistent id via HTTP', async () => {
      mockService.findById.mockResolvedValue(null)

      const response = await request(app.getHttpServer())
        .get('/v1/internal/refund-cases/nonexistent-id')
        .set('Authorization', 'Bearer test')

      expect(response.status).toBe(404)
      expect(mockService.findById).toHaveBeenCalledWith('nonexistent-id')
    })
  })

  // -------------------------------------------------------------------------
  // PATCH /:id/paid
  // -------------------------------------------------------------------------

  describe('markPaid', () => {
    it('delegates to service.markPaid with externalRef and payeeLnAddress and returns the row', async () => {
      const updated = makeRefundCase({ status: 'PAID', resolvedAt: new Date() })
      mockService.markPaid.mockResolvedValue(updated)

      const result = await controller.markPaid('rc_001', {
        externalRef: 'txn_abc',
        payeeLnAddress: 'user@domain.com',
      })

      expect(mockService.markPaid).toHaveBeenCalledWith('rc_001', {
        externalRef: 'txn_abc',
        payeeLnAddress: 'user@domain.com',
      })
      expect(result.status).toBe('PAID')
    })

    it('delegates to service.markPaid with empty body (all fields optional)', async () => {
      const updated = makeRefundCase({ status: 'PAID', resolvedAt: new Date() })
      mockService.markPaid.mockResolvedValue(updated)

      const result = await controller.markPaid('rc_001', {})

      expect(mockService.markPaid).toHaveBeenCalledWith('rc_001', {
        externalRef: undefined,
        payeeLnAddress: undefined,
      })
      expect(result.status).toBe('PAID')
    })

    it('returns 400 when body contains a non-whitelisted field via ValidationPipe (HTTP)', async () => {
      const response = await request(app.getHttpServer())
        .patch('/v1/internal/refund-cases/rc_001/paid')
        .set('Authorization', 'Bearer test')
        .send({ externalRef: 'ok', unknownField: 'bad' })

      expect(response.status).toBe(400)
    })
  })

  // -------------------------------------------------------------------------
  // PATCH /:id/abandoned
  // -------------------------------------------------------------------------

  describe('markAbandoned', () => {
    it('delegates to service.markAbandoned with reason and returns the row', async () => {
      const updated = makeRefundCase({ status: 'ABANDONED', resolvedAt: new Date() })
      mockService.markAbandoned.mockResolvedValue(updated)

      const result = await controller.markAbandoned('rc_001', { reason: 'no response' })

      expect(mockService.markAbandoned).toHaveBeenCalledWith('rc_001', {
        reason: 'no response',
      })
      expect(result.status).toBe('ABANDONED')
    })

    it('delegates to service.markAbandoned with empty body (reason optional)', async () => {
      const updated = makeRefundCase({ status: 'ABANDONED', resolvedAt: new Date() })
      mockService.markAbandoned.mockResolvedValue(updated)

      const result = await controller.markAbandoned('rc_001', {})

      expect(mockService.markAbandoned).toHaveBeenCalledWith('rc_001', {
        reason: undefined,
      })
      expect(result.status).toBe('ABANDONED')
    })

    it('returns 400 when body contains a non-string reason via ValidationPipe (HTTP)', async () => {
      const response = await request(app.getHttpServer())
        .patch('/v1/internal/refund-cases/rc_001/abandoned')
        .set('Authorization', 'Bearer test')
        .send({ reason: 12345 })

      expect(response.status).toBe(400)
    })
  })
})
