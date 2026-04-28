import { Inject, Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { FLASHNET_SERVICE } from '../flashnet/flashnet.module'
import { FlashnetService } from '../flashnet/flashnet.service'
import { FlashnetMockService } from '../flashnet/flashnet.mock'
import { usdbSmallestUnitsToDecimal } from './usdb-units'

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
          status: 'PENDING_PAYMENT',
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
}
