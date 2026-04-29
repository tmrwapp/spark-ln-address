import { Inject, Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { FLASHNET_SERVICE } from '../flashnet/flashnet.module'
import { FlashnetService } from '../flashnet/flashnet.service'
import { FlashnetMockService } from '../flashnet/flashnet.mock'
import { FlashnetWebhookPayload } from '../flashnet/flashnet.types'
import { usdbSmallestUnitsToDecimal } from './usdb-units'
import { classifyTransition, mapEventToStatus } from './swap-state-machine'
import { FLASHNET_ORDER_STATUS } from './flashnet-order-status'

export interface InitiateOnrampParams {
  /** Caller-generated cuid used as idempotency key with Flashnet and as the Invoice id. */
  idempotencyKey: string
  /** Amount in satoshis (msat / 1000, already floored by the controller). */
  amountSats: number
  /** Amount in millisatoshis (original value from the LNURL payer). */
  amountMsat: number
  /** Bech32m Spark address of the recipient. */
  recipientSparkAddress: string
  /** Lightning name id (usernameId FK on Invoice). */
  lightningNameId: string
}

export const SLIPPAGE_BPS_DEFAULT = 50

export interface InitiateOnrampResult {
  bolt11: string
  replayed: boolean
}

@Injectable()
export class SwapService {
  private readonly logger = new Logger(SwapService.name)

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLASHNET_SERVICE)
    private readonly flashnet: FlashnetService | FlashnetMockService,
  ) {}

  /**
   * Initiates a USDB onramp swap via Flashnet.
   *
   * Flow:
   * 1. Call Flashnet POST /v1/orchestration/onramp with idempotencyKey as the
   *    X-Idempotency-Key.
   * 2. On success, in a single Prisma transaction: INSERT both Invoice and
   *    FlashnetOrder with the real bolt11 and expiresAt from Flashnet.
   *
   * On Flashnet failure: throws — no DB write has occurred, so no cleanup needed.
   *
   * Returns { bolt11, replayed }.
   */
  async initiateOnramp(params: InitiateOnrampParams): Promise<InitiateOnrampResult> {
    const { idempotencyKey, amountSats, amountMsat, recipientSparkAddress, lightningNameId } = params

    this.logger.log({
      event: 'swap.initiateOnramp.start',
      idempotencyKey,
      amountSats,
    })

    // Call Flashnet — throws BadGatewayException / ServiceUnavailableException on error.
    const response = await this.flashnet.createOnrampOrder(
      {
        destinationChain: 'spark',
        destinationAsset: 'USDB',
        recipientAddress: recipientSparkAddress,
        amount: amountSats.toString(),
        amountMode: 'exact_in',
        slippageBps: SLIPPAGE_BPS_DEFAULT,
        refundAddress: recipientSparkAddress,
      },
      idempotencyKey,
    )

    const bolt11 = response.depositAddress

    // Defensive: with fresh cuids per request, replayed:true is unreachable in
    // normal operation, but guards against internal retries or fetch-layer changes.
    if (response.replayed) {
      this.logger.log({
        event: 'swap.initiateOnramp.replayed',
        idempotencyKey,
        orderId: response.orderId,
      })

      const existing = await this.prisma.flashnetOrder.findUnique({
        where: { invoiceId: idempotencyKey },
      })
      if (existing) {
        // Invoice was already created in the original request; return its bolt11.
        const invoice = await this.prisma.invoice.findUnique({
          where: { id: idempotencyKey },
          select: { bolt11: true },
        })
        return { bolt11: invoice?.bolt11 ?? bolt11, replayed: true }
      }
      // Fall through — server crashed after Flashnet but before our DB write;
      // treat as fresh and let the UNIQUE constraint guard duplicates.
    }

    // Persist Invoice and FlashnetOrder in a single transaction.
    await this.prisma.$transaction(async (tx) => {
      await tx.invoice.create({
        data: {
          id: idempotencyKey,
          usernameId: lightningNameId,
          amountMsat: BigInt(amountMsat),
          bolt11,
          expiresAt: new Date(response.expiresAt),
          receivingCurrency: 'USDB',
          destinationSparkAddress: recipientSparkAddress,
          status: 'pending',
        },
      })

      await tx.flashnetOrder.create({
        data: {
          invoiceId: idempotencyKey,
          quoteId: response.quoteId,
          orderId: response.orderId,
          lightningReceiveRequestId: response.lightningReceiveRequestId,
          estimatedOut: usdbSmallestUnitsToDecimal(response.estimatedOut),
          lockedMinAmountOut: usdbSmallestUnitsToDecimal(response.lockedMinAmountOut),
          feeAmount: usdbSmallestUnitsToDecimal(response.feeAmount),
          roundingFeeAmount: usdbSmallestUnitsToDecimal(response.roundingFeeAmount),
          totalFeeAmount: usdbSmallestUnitsToDecimal(response.totalFeeAmount),
          feeBps: response.feeBps,
          feeAsset: response.feeAsset,
          route: JSON.stringify(response.route),
          priceLockMode: response.priceLockMode,
          status: FLASHNET_ORDER_STATUS.PENDING_PAYMENT,
        },
      })
    })

    this.logger.log({
      event: 'swap.initiateOnramp.success',
      idempotencyKey,
      orderId: response.orderId,
    })

    return { bolt11, replayed: false }
  }

  /**
   * Idempotent state-machine update driven by a Flashnet webhook event.
   *
   * Contract:
   * - If the (orderId, event, timestamp) tuple was already processed
   *   (processedAt is set), this is a no-op — returns immediately.
   * - If the FlashnetOrder does not exist for the given orderId, logs a warning
   *   and returns — could be a webhook for an order we do not own.
   * - Classifies the state-machine transition and routes accordingly:
   *     - `apply`: forward transition — update FlashnetOrder.status.
   *     - `noop`:  redelivery of the same status — mark webhook processed and
   *               return without touching the order row.
   *     - `skip`:  stale / out-of-order / post-terminal delivery — mark webhook
   *               processed (so Flashnet stops retrying), log warn, do not
   *               mutate the order. Never throws back to the controller, so
   *               the response stays 204 and the retry loop is broken.
   * - On DELIVERING → FAILED: logs a structured warning for the RefundCase
   *   integration point (PR8 will wire the actual createRefundCase call).
   */
  async applyWebhookEvent(payload: FlashnetWebhookPayload): Promise<void> {
    const { event, timestamp } = payload
    const orderId = payload.data.id

    await this.prisma.$transaction(async (tx) => {
      // Upsert FlashnetWebhookEvent — INSERT if new, no-op on duplicate.
      const webhookEvent = await tx.flashnetWebhookEvent.upsert({
        where: { orderId_event_timestamp: { orderId, event, timestamp: BigInt(timestamp) } },
        create: {
          orderId,
          event,
          timestamp: BigInt(timestamp),
          rawBody: JSON.stringify(payload),
          signature: '',
        },
        update: {},
      })

      // If already processed, skip — idempotent re-ingest.
      if (webhookEvent.processedAt !== null) {
        this.logger.log({
          event: 'swap.webhook.already_processed',
          orderId,
          webhookEvent: event,
          timestamp,
        })
        return
      }

      // Look up the FlashnetOrder by orderId (include invoice for the refund-case path).
      const flashnetOrder = await tx.flashnetOrder.findFirst({
        where: { orderId },
        include: { invoice: true },
      })

      if (!flashnetOrder) {
        this.logger.warn({
          event: 'swap.webhook.unknown_order',
          orderId,
          webhookEvent: event,
        })
        // Mark the webhook event as processed so we don't log this repeatedly on replay.
        await tx.flashnetWebhookEvent.update({
          where: { id: webhookEvent.id },
          data: { processedAt: new Date() },
        })
        return
      }

      // Classify the transition. Webhook deliveries are at-least-once and not
      // strictly ordered, so duplicate (noop) and stale (skip) cases are
      // expected — handle them without throwing back to the controller.
      const decision = classifyTransition(
        flashnetOrder.status as any,
        mapEventToStatus(event),
      )

      if (decision.kind === 'noop') {
        this.logger.log({
          event: 'swap.webhook.idempotent_redelivery',
          orderId,
          status: flashnetOrder.status,
          webhookEvent: event,
        })
        await tx.flashnetWebhookEvent.update({
          where: { id: webhookEvent.id },
          data: { processedAt: new Date() },
        })
        return
      }

      if (decision.kind === 'skip') {
        this.logger.warn({
          event: 'swap.webhook.stale_or_out_of_order',
          orderId,
          currentStatus: flashnetOrder.status,
          webhookEvent: event,
          allowed: decision.allowed,
        })
        await tx.flashnetWebhookEvent.update({
          where: { id: webhookEvent.id },
          data: { processedAt: new Date() },
        })
        return
      }

      const nextStatus = decision.next

      // Build the update payload.
      const updateData: Record<string, unknown> = { status: nextStatus }

      // On order.completed: set actualOut from data.amountOut.
      if (event === 'order.completed' && payload.data.amountOut) {
        updateData.actualOut = usdbSmallestUnitsToDecimal(payload.data.amountOut)
      }

      // On order.failed / order.refunding / order.refunded: persist error fields.
      // Per docs, error details live at data.error.code and data.error.message.
      if (event === 'order.failed' || event === 'order.refunding' || event === 'order.refunded') {
        if (payload.data.error.code) updateData.errorCode = payload.data.error.code
        if (payload.data.error.message) updateData.errorMessage = payload.data.error.message
      }

      // On fee-bearing events: refresh feeAmount from data.feeAmount.
      // The docs expose only data.feeAmount in the webhook envelope; roundingFeeAmount
      // and totalFeeAmount are not part of the webhook payload shape.
      if (event === 'order.swapping' || event === 'order.completed') {
        updateData.feeAmount = usdbSmallestUnitsToDecimal(payload.data.feeAmount)
      }

      // Update FlashnetOrder.
      await tx.flashnetOrder.update({
        where: { id: flashnetOrder.id },
        data: updateData,
      })

      // Mark webhook event as processed.
      await tx.flashnetWebhookEvent.update({
        where: { id: webhookEvent.id },
        data: { processedAt: new Date() },
      })

      // DELIVERING → FAILED: refund-case integration point.
      // TODO(PR8): replace this log with RefundCaseService.createRefundCase() once
      // the refund-case module is merged from the feat/refund-case branch.
      if (event === 'order.failed' && flashnetOrder.status === FLASHNET_ORDER_STATUS.DELIVERING) {
        this.logger.warn({
          event: 'swap.refund_case_needed',
          orderId,
          invoiceId: flashnetOrder.invoiceId,
          amountSats: flashnetOrder.invoice?.amountMsat
            ? Math.floor(Number(flashnetOrder.invoice.amountMsat) / 1000)
            : null,
        })
      }

      this.logger.log({
        event: 'swap.webhook.applied',
        orderId,
        webhookEvent: event,
        previousStatus: flashnetOrder.status,
        nextStatus,
      })
    })
  }
}
