import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common'
import { Prisma, RefundCase } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'

export interface CreateRefundCaseParams {
  invoiceId: string
  amountSats: number
  reason: string
  externalRef?: string
}

export interface ListOpenRefundCasesOpts {
  limit: number
  offset: number
}

export interface ListOpenRefundCasesResult {
  data: RefundCase[]
  total: number
}

export interface MarkPaidOpts {
  externalRef?: string
  payeeLnAddress?: string
}

export interface MarkAbandonedOpts {
  reason?: string
}

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50
const DEFAULT_OFFSET = 0

@Injectable()
export class RefundCaseService {
  private readonly logger = new Logger(RefundCaseService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Opens a new RefundCase for the given invoice.
   *
   * Because `RefundCase.invoiceId` carries a `@unique` constraint, a second
   * call for the same invoice (e.g. a duplicate webhook delivery) is handled
   * gracefully: the existing row is returned instead of throwing.
   *
   * Accepts an optional `tx` Prisma client so callers running inside a
   * `$transaction` (e.g. the webhook handler) can keep the refund-case write
   * atomic with the surrounding order-status update.
   */
  async createRefundCase(
    params: CreateRefundCaseParams,
    tx?: Prisma.TransactionClient,
  ): Promise<RefundCase> {
    const { invoiceId, amountSats, reason, externalRef } = params
    const db = tx ?? this.prisma

    try {
      const refundCase = await db.refundCase.create({
        data: {
          invoiceId,
          amountSats,
          reason,
          externalRef,
          status: 'OPEN',
        },
      })

      this.logger.log(`[${refundCase.id}] refund case opened (invoice=${invoiceId} sats=${amountSats})`)

      return refundCase
    } catch (err) {
      // P2002 = unique constraint violation — the refund case already exists.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.warn(`[${invoiceId}] refund case already exists — returning existing row`)
        const existing = await db.refundCase.findUnique({
          where: { invoiceId },
        })
        // findUnique cannot return null here: the unique constraint proved it exists.
        return existing as RefundCase
      }
      throw err
    }
  }

  /**
   * Returns a paginated list of OPEN refund cases sorted by createdAt DESC.
   * Callers may override limit (capped at 200) and offset.
   */
  async listOpenRefundCases(
    opts: Partial<ListOpenRefundCasesOpts> = {},
  ): Promise<ListOpenRefundCasesResult> {
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
    const offset = opts.offset ?? DEFAULT_OFFSET

    const [data, total] = await this.prisma.$transaction([
      this.prisma.refundCase.findMany({
        where: { status: 'OPEN' },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.refundCase.count({ where: { status: 'OPEN' } }),
    ])

    return { data, total }
  }

  /**
   * Returns a single RefundCase by id, or null when it does not exist.
   */
  async findById(id: string): Promise<RefundCase | null> {
    return this.prisma.refundCase.findUnique({ where: { id } })
  }

  /**
   * Marks a RefundCase as PAID and records optional resolution metadata.
   * Throws NotFoundException when the id does not exist.
   * Throws BadRequestException when the row is not OPEN.
   */
  async markPaid(id: string, opts: MarkPaidOpts = {}): Promise<RefundCase> {
    const existing = await this.prisma.refundCase.findUnique({ where: { id } })

    if (!existing) {
      throw new NotFoundException(`RefundCase ${id} not found`)
    }

    if (existing.status !== 'OPEN') {
      throw new BadRequestException(
        `RefundCase ${id} is already in status '${existing.status}' and cannot be marked PAID`,
      )
    }

    const updated = await this.prisma.refundCase.update({
      where: { id },
      data: {
        status: 'PAID',
        resolvedAt: new Date(),
        ...(opts.externalRef !== undefined && { externalRef: opts.externalRef }),
        ...(opts.payeeLnAddress !== undefined && { payeeLnAddress: opts.payeeLnAddress }),
      },
    })

    this.logger.log(`[${id}] refund case paid`)

    return updated
  }

  /**
   * Marks a RefundCase as ABANDONED.
   * Throws NotFoundException when the id does not exist.
   * Throws BadRequestException when the row is not OPEN.
   */
  async markAbandoned(id: string, opts: MarkAbandonedOpts = {}): Promise<RefundCase> {
    const existing = await this.prisma.refundCase.findUnique({ where: { id } })

    if (!existing) {
      throw new NotFoundException(`RefundCase ${id} not found`)
    }

    if (existing.status !== 'OPEN') {
      throw new BadRequestException(
        `RefundCase ${id} is already in status '${existing.status}' and cannot be marked ABANDONED`,
      )
    }

    const updated = await this.prisma.refundCase.update({
      where: { id },
      data: {
        status: 'ABANDONED',
        resolvedAt: new Date(),
        ...(opts.reason !== undefined && { reason: opts.reason }),
      },
    })

    this.logger.log(`[${id}] refund case abandoned`)

    return updated
  }
}
