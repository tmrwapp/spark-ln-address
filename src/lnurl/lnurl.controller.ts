import { Controller, Get, Param, NotFoundException, Query, BadRequestException, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { LnurlService } from './lnurl.service'
import { LightsparkService } from '../lightspark/lightspark.service'
import { LnurlPayMetadataDto } from '../common/lnurl-pay-metadata.dto'
import { LnurlCallbackResponseDto } from '../common/lnurl-callback-response.dto'
import { LNURL_CONSTANTS } from '../common/constants'
import { getDomainFromBaseUrl } from '../common/utils'

@Controller()
export class LnurlController {
  private readonly logger = new Logger(LnurlController.name);
  constructor(
    private readonly lnurlService: LnurlService,
    private readonly lightsparkService: LightsparkService,
    private readonly configService: ConfigService,
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
  ): Promise<LnurlCallbackResponseDto> {
    // Validate amount parameter
    if (!amountStr) {
      throw new BadRequestException('Missing amount parameter')
    }

    const amountMsat = parseInt(amountStr, 10)
    if (isNaN(amountMsat) || amountMsat < LNURL_CONSTANTS.MIN_SENDABLE_MSAT || amountMsat > LNURL_CONSTANTS.MAX_SENDABLE_MSAT) {
      throw new BadRequestException(`Amount must be between ${LNURL_CONSTANTS.MIN_SENDABLE_MSAT} and ${LNURL_CONSTANTS.MAX_SENDABLE_MSAT} msat`)
    }

    // Check if username exists and is active
    const lightningName = await this.lnurlService.findActiveLightningName(rawUsername)
    if (!lightningName) {
      throw new NotFoundException('Username not found')
    }
    this.logger.log(`Found user with name: ${lightningName.username}`)

    // Validate Lightspark public key
    if (!lightningName.linkingPubKeyHex) {
      throw new BadRequestException('Lightspark public key not found')
    }
    this.logger.log(`Lightspark public key: ${lightningName.linkingPubKeyHex}`)
    const sparkPubKeyHex = lightningName.linkingPubKeyHex

    this.logger.log(`Creating invoice for amount: ${amountMsat} msat`)
    // Create invoice via Lightspark
    const domain = getDomainFromBaseUrl(this.configService.get<string>('PUBLIC_BASE_URL')!)
    const memo = comment ? `${lightningName.username}@${domain}: ${comment}` : `${lightningName.username}@${domain}`
    this.logger.log(`Memo: ${memo}`)
    const invoiceResult = await this.lightsparkService.createInvoice(sparkPubKeyHex, amountMsat, memo)
    this.logger.log(`Invoice created: ${invoiceResult.bolt11}`)
    // Persist invoice in database
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
}
