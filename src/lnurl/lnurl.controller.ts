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

/**
 * Extracts a short reason string from an unknown error for log/response use.
 * Prefers Flashnet's `code` (BadGatewayException response body), falls back
 * to `err.message`, and finally to `'unknown'` for non-Error throws.
 */
function extractErrorReason(err: unknown): string {
  if (err instanceof BadGatewayException) {
    const code = (err.getResponse() as Record<string, unknown>)?.code
    if (typeof code === 'string') return code
    return err.message
  }
  if (err && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  return 'unknown'
}

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
      `[${lightningName.username}] callback amount=${amountMsat}msat route=${useUsdbRoute ? 'usdb' : 'sats'}`,
    )

    // USDB is best-effort. If anything in the USDB branch fails (most often a
    // sub-Flashnet-minimum amount), fall through to the sats path so the
    // payment still goes through.
    if (useUsdbRoute) {
      try {
        return await this.handleUsdbCallback(lightningName, amountMsat)
      } catch (err: any) {
        const reason = extractErrorReason(err)
        this.logger.warn(`[${lightningName.username}] usdb unavailable (${reason}), using sats`)
      }
    }

    // LUD-06: callback errors must be returned as `{ status: 'ERROR', reason }`
    // with HTTP 200, not as a thrown exception (which would surface as 5xx and
    // confuse compliant wallets). Catch any sats issuance failure here.
    try {
      return await this.issueSatsBolt11(lightningName, amountMsat, comment)
    } catch (err: any) {
      const reason = extractErrorReason(err)
      this.logger.error(`[${lightningName.username}] sats issuance failed: ${reason}`)
      return { status: 'ERROR', reason }
    }
  }

  /**
   * USDB onramp path. Throws on any failure (encode failure, Flashnet error,
   * etc.) so the caller in handleLnurlCallback can fall back to the sats path.
   * On success: returns the BOLT11 invoice and persists Invoice + FlashnetOrder
   * in a single transaction inside SwapService.
   */
  private async handleUsdbCallback(
    lightningName: { id: string; linkingPubKeyHex: string; username: string },
    amountMsat: number,
  ): Promise<LnurlCallbackResponseDto> {
    const sparkNetwork = (this.configService.get<string>('SPARK_NETWORK') ?? 'MAINNET') as SparkNetwork
    const recipient = await encodeSparkAddress(lightningName.linkingPubKeyHex, sparkNetwork)

    const amountSats = Math.floor(amountMsat / 1000)
    const idempotencyKey = createId()

    const result = await this.swapService.initiateOnramp({
      idempotencyKey,
      lightningNameId: lightningName.id,
      amountMsat,
      amountSats,
      recipientSparkAddress: recipient,
    })

    this.logger.log(`[${lightningName.username}] usdb onramp ok (key=${idempotencyKey})`)

    return { pr: result.bolt11, routes: [] }
  }

  /**
   * Issues a Lightning invoice via Lightspark and persists it. Used by the
   * default sats branch and as the fallback when the USDB branch throws.
   */
  private async issueSatsBolt11(
    lightningName: { id: string; linkingPubKeyHex: string; username: string },
    amountMsat: number,
    comment?: string,
  ): Promise<LnurlCallbackResponseDto> {
    const domain = getDomainFromBaseUrl(this.configService.get<string>('PUBLIC_BASE_URL')!)
    const memo = comment
      ? `${lightningName.username}@${domain}: ${comment}`
      : `${lightningName.username}@${domain}`
    const invoiceResult = await this.lightsparkService.createInvoice(
      lightningName.linkingPubKeyHex,
      amountMsat,
      memo,
    )
    await this.lnurlService.createInvoice({
      usernameId: lightningName.id,
      amountMsat: BigInt(amountMsat),
      bolt11: invoiceResult.bolt11,
      expiresAt: invoiceResult.expiresAt,
    })
    return { pr: invoiceResult.bolt11, routes: [] }
  }
}
