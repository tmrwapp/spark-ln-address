import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { setTimeout as delay } from 'node:timers/promises'
import { PrismaService } from '../prisma/prisma.service'
import { FLASHNET_SERVICE } from '../flashnet/flashnet.module'
import { FlashnetService } from '../flashnet/flashnet.service'
import { SwapService } from './swap.service'

// Flashnet allows delayed settlement during its six-hour recovery window.
export const SETTLEMENT_GRACE_MS = 6 * 60 * 60 * 1000

const TERMINAL = ['DELIVERED', 'FAILED', 'EXPIRED', 'REFUNDED']

const errorReason = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error'

/** Durable quote lookup covers missed webhooks, restarts, and delayed funding. */
@Injectable()
export class QuoteReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QuoteReconciler.name)
  private readonly stop = new AbortController()
  private readonly cursors: Array<string | undefined> = [
    undefined,
    undefined,
    undefined,
  ]
  private running = false

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLASHNET_SERVICE) private readonly flashnet: FlashnetService,
    private readonly swaps: SwapService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (
      this.config.get('FLASHNET_API_KEY') &&
      this.config.get('NODE_ENV') !== 'test'
    ) {
      void this.run()
    }
  }

  onModuleDestroy(): void {
    this.stop.abort()
  }

  private async run(): Promise<void> {
    while (!this.stop.signal.aborted) {
      try {
        await this.reconcileBatch()
      } catch (error) {
        this.logger.warn(
          `Quote reconciliation unavailable: ${errorReason(error)}`,
        )
      }
      try {
        await delay(30_000, undefined, { signal: this.stop.signal })
      } catch {
        return
      }
    }
  }

  async reconcileBatch(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      // Reserve independent capacity for active orders and fresh/recently expired quotes.
      // Old unpaid invoices still get late-settlement checks, but cannot delay
      // a current payment behind an ever-growing archive of abandoned quotes.
      const recentExpiry = new Date(Date.now() - SETTLEMENT_GRACE_MS)
      const queues = [
        { where: { orderId: { not: null } }, take: 20 },
        {
          where: {
            orderId: null,
            invoice: { expiresAt: { gt: recentExpiry } },
          },
          take: 20,
        },
        {
          where: {
            orderId: null,
            invoice: { expiresAt: { lte: recentExpiry } },
          },
          take: 5,
        },
      ]
      for (let queue = 0; queue < queues.length; queue++) {
        const { where, take } = queues[queue]
        const cursor = this.cursors[queue]
        const rows = await this.prisma.flashnetOrder.findMany({
          where: {
            ...where,
            quoteId: { not: null },
            status: { notIn: TERMINAL },
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take,
        })
        this.cursors[queue] =
          rows.length === take ? rows[rows.length - 1].id : undefined
        for (const row of rows) {
          if (this.stop.signal.aborted) return
          try {
            const snapshot = await this.flashnet.getQuoteOrder(row.quoteId)
            if (!snapshot) continue // Awaiting payment; not a failed payment.
            if (row.orderId && snapshot.id !== row.orderId)
              throw new Error('Order mismatch')
            // Local correlation is independently checked even if a mocked client
            // or future adapter omits the HTTP client's validation.
            if (snapshot.quoteId !== row.quoteId)
              throw new Error('Quote mismatch')
            const timestamp = Date.parse(snapshot.updatedAt)
            if (!Number.isSafeInteger(timestamp))
              throw new Error('Invalid snapshot time')
            await this.swaps.applyWebhookEvent({
              event: `order.${snapshot.status}`,
              timestamp: String(timestamp),
              data: snapshot,
            })
            if (
              ['pending_review', 'blocked_wallet'].includes(
                snapshot.reviewStatus,
              )
            ) {
              await this.swaps.applyWebhookEvent({
                event: 'order.recovery_required',
                timestamp: String(timestamp),
                data: snapshot,
              })
            }
          } catch (error) {
            // Identify the payment so a stuck order can be traced. The errors that
            // reach here are short provider/validation/DB messages; none carries
            // an invoice, API key or request header.
            this.logger.warn(
              `[${row.quoteId}] quote reconciliation deferred (order=${row.orderId ?? 'none'}): ${errorReason(error)}`,
            )
          }
        }
      }
    } finally {
      this.running = false
    }
  }
}
