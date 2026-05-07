import { Controller, Get, Param, NotFoundException, Query, BadRequestException, BadGatewayException, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createId } from '@paralleldrive/cuid2'
import { LnurlService } from './lnurl.service'
import { LightsparkService } from '../lightspark/lightspark.service'
import { LnurlPayMetadataDto } from '../common/lnurl-pay-metadata.dto'
import { LnurlCallbackResponseDto } from '../common/lnurl-callback-response.dto'
import { LNURL_CONSTANTS } from '../common/constants'
import { getDomainFromBaseUrl } from '../common/utils'
import type { SparkNetwork } from '../common/spark-address.utils'
import { encodeSparkAddress } from '../common/spark-address.utils'
import { SwapService } from '../swap/swap.service'

@Controller()
export class LnurlController {
  private readonly logger = new Logger(LnurlController.name);
  constructor(
    private readonly lnurlService: LnurlService,
    private readonly lightsparkService: LightsparkService,
    private readonly configService: ConfigService,
    private readonly swapService: SwapService,
  ) {}

  @Get('.well-known/lnurlp/:username')
  async getLnurlPayMetadata(
    @Param('username') rawUsername: string,
  ): Promise<LnurlPayMetadataDto> {
    const publicBaseUrl = this.configService.get<string>('PUBLIC_BASE_URL')
    if (!publicBaseUrl) {
      throw new Error('PUBLIC_BASE_URL not configured')
    }

    // Check if username exists and is active
    const lightningName = await this.lnurlService.findActiveLightningName(rawUsername)
    if (!lightningName) {
      throw new NotFoundException('Username not found')
    }

    const domain = getDomainFromBaseUrl(publicBaseUrl)
    const callback = `${publicBaseUrl}/lnurl/callback/${lightningName.username}`

    return {
      status: 'OK',
      tag: 'payRequest',
      callback,
      minSendable: LNURL_CONSTANTS.MIN_SENDABLE_MSAT,
      maxSendable: LNURL_CONSTANTS.MAX_SENDABLE_MSAT,
      metadata: [[ 'text/plain', `${lightningName.username}@${domain}` ]],
      commentAllowed: LNURL_CONSTANTS.COMMENT_ALLOWED,
    }
  }

  @Get('lnurl/callback/:username')
  async handleLnurlCallback(
    @Param('username') rawUsername: string,
    @Query('amount') amountStr: string,
    @Query('comment') comment?: string,
  ): Promise<LnurlCallbackResponseDto | { status: 'ERROR'; reason: string }> {
    // Validate amount parameter
    if (!amountStr) {
      throw new BadRequestException('Missing amount parameter')
    }

    const amountMsat = parseInt(amountStr, 10)
    if (isNaN(amountMsat) || amountMsat < LNURL_CONSTANTS.MIN_SENDABLE_MSAT || amountMsat > LNURL_CONSTANTS.MAX_SENDABLE_MSAT) {
      throw new BadRequestException(`Amount must be between ${LNURL_CONSTANTS.MIN_SENDABLE_MSAT} and ${LNURL_CONSTANTS.MAX_SENDABLE_MSAT} msat`)
    }

    // Load lightning name with associated user (for defaultReceivingCurrency).
    const lightningName = await this.lnurlService.findActiveLightningNameWithUser(rawUsername)
    if (!lightningName) {
      throw new NotFoundException('Username not found')
    }

    // Validate Lightspark public key
    if (!lightningName.linkingPubKeyHex) {
      throw new BadRequestException('Lightspark public key not found')
    }

    // Kill switch + per-user preference gate.
    const usdbEnabled = this.configService.get<string>('USDB_ENABLED')
    const defaultReceivingCurrency = lightningName.user.defaultReceivingCurrency
    const useUsdbRoute = usdbEnabled === 'true' && defaultReceivingCurrency === 'USDB'

    this.logger.log(
      `[${lightningName.username}] callback amount=${amountMsat}, msat route=${useUsdbRoute ? 'usdb' : 'sats'}`,
    )

    if (useUsdbRoute) {
      this.logger.log(`[${lightningName.username}] using usdb route`)
      return this.handleUsdbCallback(lightningName, amountMsat)
    }
    this.logger.log(`[${lightningName.username}] using sats route`)

    // ---- SATS path (existing, unchanged) ----
    const sparkPubKeyHex = lightningName.linkingPubKeyHex
    const domain = getDomainFromBaseUrl(this.configService.get<string>('PUBLIC_BASE_URL')!)
    const memo = comment ? `${lightningName.username}@${domain}: ${comment}` : `${lightningName.username}@${domain}`
    const invoiceResult = await this.lightsparkService.createInvoice(sparkPubKeyHex, amountMsat, memo)
    await this.lnurlService.createInvoice({
      usernameId: lightningName.id,
      amountMsat: BigInt(amountMsat),
      bolt11: invoiceResult.bolt11,
      expiresAt: invoiceResult.expiresAt,
    })

    return {
      pr: invoiceResult.bolt11,
      routes: [],
    }
  }

  /**
   * USDB onramp path:
   * 1. Encode the user's Spark address from their linking pubkey.
   * 2. Pre-generate a cuid as idempotency key (also becomes the Invoice id).
   * 3. Call SwapService.initiateOnramp, which calls Flashnet then — on success —
   *    INSERTs both Invoice and FlashnetOrder in a single transaction.
   * 4. Return the BOLT11 to the payer.
   *
   * On Flashnet error: SwapService throws before any DB write; return LNURL error.
   * No cleanup needed — nothing was persisted.
   */
  private async handleUsdbCallback(
    lightningName: { id: string; linkingPubKeyHex: string; username: string },
    amountMsat: number,
  ): Promise<LnurlCallbackResponseDto | { status: 'ERROR'; reason: string }> {
    // Step 1: derive recipient Spark address
    let recipient: string
    try {
      const sparkNetwork = (this.configService.get<string>('SPARK_NETWORK') ?? 'MAINNET') as SparkNetwork
      recipient = await encodeSparkAddress(lightningName.linkingPubKeyHex, sparkNetwork)
    } catch (err) {
      this.logger.warn(`[${lightningName.username}] spark address encode failed: ${String(err)}`)
      return { status: 'ERROR', reason: 'Invalid Spark address' }
    }

    const amountSats = Math.floor(amountMsat / 1000)

    // Step 2: pre-generate idempotency key (doubles as Invoice id)
    const idempotencyKey = createId()

    // Step 3: call Flashnet via SwapService — persists Invoice + FlashnetOrder on success
    let bolt11: string
    try {
      const result = await this.swapService.initiateOnramp({
        idempotencyKey,
        lightningNameId: lightningName.id,
        amountMsat,
        amountSats,
        recipientSparkAddress: recipient,
      })
      bolt11 = result.bolt11
    } catch (err: any) {
      // No DB write happened — nothing to clean up.
      const code: string =
        err instanceof BadGatewayException
          ? ((err.getResponse() as Record<string, unknown>)?.code as string | undefined) ?? err.message
          : (typeof err?.message === 'string' ? err.message : 'service_unavailable')
      this.logger.warn(`[${idempotencyKey}] flashnet error: ${code}`)
      return { status: 'ERROR', reason: code }
    }

    this.logger.log(`[${lightningName.username}] usdb onramp ok (key=${idempotencyKey})`)

    return { pr: bolt11, routes: [] }
  }
}
