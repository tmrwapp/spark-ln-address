import { Prisma } from '@prisma/client'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { FLASHNET_SERVICE } from '../flashnet/flashnet.module'
import { FlashnetService } from '../flashnet/flashnet.service'
import { FlashnetMockService } from '../flashnet/flashnet.mock'
import { FlashnetWebhookPayload } from '../flashnet/flashnet.types'
import { RefundCaseService } from '../refund-case/refund-case.service'
import { usdbSmallestUnitsToDecimal } from './usdb-units'
import { classifyTransition, mapEventToStatus } from './swap-state-machine'
import { FLASHNET_ORDER_STATUS } from './flashnet-order-status'

export interface InitiateLightningQuoteParams {
  /** Caller-generated cuid used as idempotency key with Flashnet and as the Invoice id. */
  idempotencyKey: string
  /** Amount in satoshis (msat / 1000, validated as a whole-satoshi amount by the controller). */
  amountSats: number
  /** Amount in millisatoshis (original value from the LNURL payer). */
  amountMsat: number
  /** Bech32m Spark address of the recipient. */
  recipientSparkAddress: string
  /** Lightning name id (usernameId FK on Invoice). */
  lightningNameId: string
}

export const SLIPPAGE_BPS_DEFAULT = 50

export interface InitiateLightningQuoteResult {
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
    private readonly refundCaseService: RefundCaseService,
  ) {}

  /**
   * Creates an unfunded Lightning-to-USDB quote via Flashnet.
   *
   * Flow:
   * 1. Call Flashnet POST /v1/orchestration/quote with idempotencyKey as the
   *    X-Idempotency-Key.
   * 2. On success, in a single Prisma transaction: INSERT both Invoice and
   *    FlashnetOrder with the real bolt11 and expiry. orderId stays null until funding.
   *
   * On Flashnet failure: throws — no DB write has occurred, so no cleanup needed.
   *
   * Returns { bolt11, replayed }.
   */
  async initiateLightningQuote(
    params: InitiateLightningQuoteParams,
  ): Promise<InitiateLightningQuoteResult> {
    const {
      idempotencyKey,
      amountSats,
      amountMsat,
      recipientSparkAddress,
      lightningNameId,
    } = params

    // LNURL does not identify the payer wallet. All general Lightning-address
    // receives use /quote; dedicated Cash App checkout is a separate flow.
    // No source refund address can be inferred from the recipient's Spark address.
    const response = await this.flashnet.createLightningQuote(
      {
        sourceChain: 'lightning',
        sourceAsset: 'BTC',
        destinationChain: 'spark',
        destinationAsset: 'USDB',
        recipientAddress: recipientSparkAddress,
        amount: amountSats.toString(),
        amountMode: 'exact_in',
        slippageBps: SLIPPAGE_BPS_DEFAULT,
      },
      idempotencyKey,
    )

    const bolt11 = response.depositAddress

    // Defensive: with fresh cuids per request, replayed:true is unreachable in
    // normal operation, but guards against internal retries or fetch-layer changes.
    if (response.replayed) {
      this.logger.warn(
        `[${response.quoteId}] flashnet replayed (key=${idempotencyKey})`,
      )

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
          orderId: null,
          lightningReceiveRequestId: response.lightningReceiveRequestId,
          estimatedOut: usdbSmallestUnitsToDecimal(response.estimatedOut),
          lockedMinAmountOut:
            response.lockedMinAmountOut == null
              ? null
              : usdbSmallestUnitsToDecimal(response.lockedMinAmountOut),
          feeAmount: usdbSmallestUnitsToDecimal(response.feeAmount),
          roundingFeeAmount: usdbSmallestUnitsToDecimal(
            response.roundingFeeAmount,
          ),
          totalFeeAmount: usdbSmallestUnitsToDecimal(response.totalFeeAmount),
          feeBps: response.feeBps,
          feeAsset: response.feeAsset,
          route: JSON.stringify(response.route),
          priceLockMode: response.priceLockMode,
          status: FLASHNET_ORDER_STATUS.PENDING_PAYMENT,
        },
      })
    })

    this.logger.log(
      `[${response.quoteId}] quote created (invoice=${idempotencyKey} sats=${amountSats})`,
    )

    return { bolt11, replayed: false }
  }

  /**
   * Idempotent state-machine update driven by a Flashnet webhook event.
   *
   * Contract:
   * - If the (orderId, event, timestamp) tuple was already processed
   *   (processedAt is set), this is a no-op — returns immediately.
   * - Bind newly funded orders by the authenticated snapshot's quoteId.
   * - Classifies the state-machine transition and routes accordingly:
   *     - `apply`: forward transition — update FlashnetOrder.status.
   *     - `noop`:  redelivery of the same status — mark webhook processed and
   *               return without touching the order row.
   *     - `skip`:  stale / out-of-order / post-terminal delivery — mark webhook
   *               processed (so Flashnet stops retrying), log warn, do not
   *               mutate the order. Never throws back to the controller, so
   *               the response stays 204 and the retry loop is broken.
   * - Failed deliveries and recovery holds open an ops case. A Lightning
   *   payer has no inferred return address; never promise an automatic refund.
   */
  async applyWebhookEvent(payload: FlashnetWebhookPayload): Promise<void> {
    const { event, timestamp } = payload
    const orderId = payload.data.id

    await this.prisma.$transaction(
      async (tx) => {
        // Upsert FlashnetWebhookEvent — INSERT if new, no-op on duplicate.
        const webhookEvent = await tx.flashnetWebhookEvent.upsert({
          where: {
            orderId_event_timestamp: {
              orderId,
              event,
              timestamp: BigInt(timestamp),
            },
          },
          create: {
            orderId,
            event,
            timestamp: BigInt(timestamp),
            rawBody: JSON.stringify(payload),
            signature: '',
          },
          update: {},
        })

        // If already processed, skip — idempotent re-ingest. Silent: this is
        // expected on Flashnet redelivery and would only add noise to logs.
        if (webhookEvent.processedAt !== null) {
          return
        }

        // Look up the FlashnetOrder by orderId (include invoice for the refund-case path).
        let flashnetOrder = await tx.flashnetOrder.findFirst({
          where: { orderId },
          include: { invoice: true },
        })

        if (!flashnetOrder && payload.data.quoteId) {
          flashnetOrder = await tx.flashnetOrder.findFirst({
            where: { quoteId: payload.data.quoteId, orderId: null },
            include: { invoice: true },
          })
          if (flashnetOrder) {
            await tx.flashnetOrder.update({
              where: { id: flashnetOrder.id },
              data: { orderId },
            })
          }
        }
        if (
          flashnetOrder &&
          payload.data.quoteId &&
          flashnetOrder.quoteId !== payload.data.quoteId
        ) {
          throw new Error('Order quote does not match stored payment')
        }

        if (!flashnetOrder) {
          this.logger.warn(`[${orderId}] unknown order (${event})`)
          // Leave unprocessed: this can race quote persistence. The durable
          // reconciler will apply the snapshot once its quote is present.
          return
        }

        const terminal = [
          FLASHNET_ORDER_STATUS.DELIVERED,
          FLASHNET_ORDER_STATUS.REFUNDED,
          FLASHNET_ORDER_STATUS.FAILED,
          FLASHNET_ORDER_STATUS.EXPIRED,
        ] as string[]
        if (event === 'order.recovery_required') {
          if (terminal.includes(flashnetOrder.status)) {
            await tx.flashnetWebhookEvent.update({
              where: { id: webhookEvent.id },
              data: { processedAt: new Date() },
            })
            return
          }
          await this.refundCaseService.createRefundCase(
            {
              invoiceId: flashnetOrder.invoiceId,
              amountSats: Math.floor(
                Number(flashnetOrder.invoice?.amountMsat ?? 0) / 1000,
              ),
              reason: 'PAYMENT_RECOVERY_REQUIRED',
            },
            tx,
          )
          await tx.flashnetWebhookEvent.update({
            where: { id: webhookEvent.id },
            data: { processedAt: new Date() },
          })
          return
        }

        // Classify the transition. Webhook deliveries are at-least-once and not
        // strictly ordered, so duplicate (noop) and stale (skip) cases are
        // expected — handle them without throwing back to the controller.
        const attemptedStatus = mapEventToStatus(event)
        // Webhooks may arrive out of order; the first observed snapshot can
        // already be completed. Do not require a processing event first.
        const currentStatus =
          flashnetOrder.status === FLASHNET_ORDER_STATUS.PENDING_PAYMENT &&
          attemptedStatus !== FLASHNET_ORDER_STATUS.PROCESSING
            ? FLASHNET_ORDER_STATUS.PROCESSING
            : flashnetOrder.status
        const decision =
          !terminal.includes(currentStatus) &&
          terminal.includes(attemptedStatus)
            ? { kind: 'apply' as const, next: attemptedStatus }
            : classifyTransition(currentStatus as any, attemptedStatus)

        if (decision.kind === 'noop') {
          this.logger.log(`[${orderId}] ${flashnetOrder.status} (redelivery)`)
          await tx.flashnetWebhookEvent.update({
            where: { id: webhookEvent.id },
            data: { processedAt: new Date() },
          })
          return
        }

        if (decision.kind === 'skip') {
          this.logger.warn(
            `[${orderId}] ${flashnetOrder.status}->${attemptedStatus} ignored (stale)`,
          )
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
          updateData.actualOut = usdbSmallestUnitsToDecimal(
            payload.data.amountOut,
          )
        }

        // On order.failed / order.refunding / order.refunded: persist error fields.
        // Per docs, error details live at data.error.code and data.error.message.
        if (
          event === 'order.failed' ||
          event === 'order.refunding' ||
          event === 'order.refunded'
        ) {
          if (payload.data.error?.code)
            updateData.errorCode = payload.data.error?.code
          if (payload.data.error?.message)
            updateData.errorMessage = payload.data.error?.message
        }

        // On fee-bearing events: refresh feeAmount from data.feeAmount.
        // The docs expose only data.feeAmount in the webhook envelope; roundingFeeAmount
        // and totalFeeAmount are not part of the webhook payload shape.
        if (
          (event === 'order.swapping' || event === 'order.completed') &&
          payload.data.feeAmount != null &&
          (!payload.data.feeAsset ||
            payload.data.feeAsset === flashnetOrder.feeAsset)
        ) {
          updateData.feeAmount = usdbSmallestUnitsToDecimal(
            payload.data.feeAmount,
          )
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

        // Any failed payment needs an ops case; do not infer a Lightning refund target.
        // See applyWebhookEvent doc comment for the rationale (defensive backstop).
        // Idempotent on RefundCase.invoiceId @unique; runs inside the surrounding
        // tx so a crash mid-flow can't leave the order updated without the case.
        if (event === 'order.failed') {
          const amountSats = flashnetOrder.invoice?.amountMsat
            ? Math.floor(Number(flashnetOrder.invoice.amountMsat) / 1000)
            : 0
          const reason = `PAYMENT_FAILED: ${payload.data.error?.code ?? 'no_code'} | ${payload.data.error?.message ?? 'no_message'}`
          await this.refundCaseService.createRefundCase(
            {
              invoiceId: flashnetOrder.invoiceId,
              amountSats,
              reason,
            },
            tx,
          )
        }

        let finalSummary: string | undefined
        if (nextStatus === FLASHNET_ORDER_STATUS.DELIVERED) {
          const amountSats = Number(flashnetOrder.invoice?.amountMsat) / 1e3
          const amountUsdb = Intl.NumberFormat('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 6,
          }).format(Number(updateData.actualOut))
          finalSummary = `, received [${amountSats} sats], delivered [${amountUsdb} USDB]`
        }
        this.logger.log(
          `[${orderId}] ${flashnetOrder.status}->${nextStatus} ${finalSummary ?? ''}`,
        )
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
  }
}
