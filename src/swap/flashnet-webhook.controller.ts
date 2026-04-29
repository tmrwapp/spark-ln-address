import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { Request } from 'express'
import { FLASHNET_SERVICE } from '../flashnet/flashnet.module'
import { FlashnetService } from '../flashnet/flashnet.service'
import { FlashnetMockService } from '../flashnet/flashnet.mock'
import { FlashnetWebhookPayload } from '../flashnet/flashnet.types'
import { SwapService } from './swap.service'
import { PrismaService } from '../prisma/prisma.service'

/**
 * Webhook receiver for Flashnet order lifecycle events.
 *
 * Auth: HMAC-SHA256 verification via X-Flashnet-Signature + X-Flashnet-Timestamp.
 * No NestJS auth guard is applied — HMAC is the authentication mechanism.
 *
 * Deduplication: (orderId, event, timestamp) unique constraint on FlashnetWebhookEvent.
 * Duplicate deliveries return 204 without re-processing.
 *
 * Raw body: relies on NestFactory.create({ rawBody: true }) wired in main.ts (PR3).
 */
@Controller('v1/internal/flashnet')
export class FlashnetWebhookController {
  private readonly logger = new Logger(FlashnetWebhookController.name)

  constructor(
    private readonly swapService: SwapService,
    private readonly prisma: PrismaService,
    @Inject(FLASHNET_SERVICE)
    private readonly flashnet: FlashnetService | FlashnetMockService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.NO_CONTENT)
  async handleWebhook(@Req() req: Request): Promise<void> {
    // Raw body must be present — wired by NestFactory.create({ rawBody: true }).
    const rawBody: Buffer | undefined = (req as Request & { rawBody?: Buffer }).rawBody
    if (!rawBody) {
      this.logger.error({
        event: 'flashnet.webhook.missing_raw_body',
        url: req.url,
      })
      // 400 semantics: raw-body wiring is broken — server configuration error.
      throw Object.assign(new Error('Raw body unavailable'), { status: 400 })
    }

    const signature = (req.headers['x-flashnet-signature'] as string) ?? ''
    const timestamp = (req.headers['x-flashnet-timestamp'] as string) ?? ''

    if (!signature || !timestamp) {
      this.logger.warn({
        event: 'flashnet.webhook.missing_headers',
        hasSignature: Boolean(signature),
        hasTimestamp: Boolean(timestamp),
      })
      throw new UnauthorizedException('Missing HMAC signature headers')
    }

    // HMAC verification — constant-time comparison inside FlashnetService.
    const valid = this.flashnet.verifyWebhookSignature(rawBody, signature, timestamp)
    if (!valid) {
      this.logger.warn({
        event: 'flashnet.webhook.invalid_signature',
        timestamp,
      })
      throw new UnauthorizedException('Invalid webhook signature')
    }

    // Parse body after HMAC validation.
    let payload: FlashnetWebhookPayload
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as FlashnetWebhookPayload
    } catch (err) {
      this.logger.warn({
        event: 'flashnet.webhook.parse_error',
        error: String(err),
      })
      // Malformed JSON after valid HMAC — unusual; return 204 to stop retries.
      return
    }

    // Stamp the timestamp from the header into the payload so applyWebhookEvent
    // can use it for the dedupe key without trusting the body timestamp.
    payload.timestamp = timestamp

    this.logger.log({
      event: 'flashnet.webhook.received',
      orderId: payload.data.id,
      webhookEvent: payload.event,
      timestamp,
    })

    await this.swapService.applyWebhookEvent(payload)
    // Always return 204 — Flashnet interprets any 2xx as acknowledged.
  }
}
