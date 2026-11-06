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
import { ConfigService } from '@nestjs/config'
import { FLASHNET_SERVICE } from '../flashnet/flashnet.module'
import { FlashnetService } from '../flashnet/flashnet.service'
import { FlashnetMockService } from '../flashnet/flashnet.mock'
import { FlashnetWebhookPayload } from '../flashnet/flashnet.types'
import { errorForLog, sanitizeForLog } from '../common/log-sanitize'
import { SwapService } from './swap.service'
import { PrismaService } from '../prisma/prisma.service'
import {
  DEFAULT_WEBHOOK_MAX_SKEW_MS,
  MAX_WEBHOOK_MAX_SKEW_MS,
  isFreshTimestamp,
} from './webhook-timestamp'

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

  private readonly maxSkewMs: number

  constructor(
    private readonly swapService: SwapService,
    private readonly prisma: PrismaService,
    @Inject(FLASHNET_SERVICE)
    private readonly flashnet: FlashnetService | FlashnetMockService,
    config: ConfigService,
  ) {
    this.maxSkewMs = this.readMaxSkewMs(
      config.get<string>('FLASHNET_WEBHOOK_MAX_SKEW_MS'),
    )
  }

  private readMaxSkewMs(raw: string | undefined): number {
    if (raw === undefined || raw === '') {
      return DEFAULT_WEBHOOK_MAX_SKEW_MS
    }
    // Plain decimal milliseconds, at most one hour: `5m`, `0x10` or `1e9`
    // would otherwise disable or distort the freshness check silently.
    const value = /^\d{1,10}$/.test(raw) ? Number(raw) : NaN
    if (!(value > 0 && value <= MAX_WEBHOOK_MAX_SKEW_MS)) {
      this.logger.warn({
        event: 'flashnet.webhook_invalid_max_skew',
        fallbackMs: DEFAULT_WEBHOOK_MAX_SKEW_MS,
      })
      return DEFAULT_WEBHOOK_MAX_SKEW_MS
    }
    return value
  }

  @Post('webhook')
  @HttpCode(HttpStatus.NO_CONTENT)
  async handleWebhook(@Req() req: Request): Promise<void> {
    // Raw body must be present — wired by NestFactory.create({ rawBody: true }).
    const rawBody: Buffer | undefined = (req as Request & { rawBody?: Buffer })
      .rawBody
    if (!rawBody) {
      this.logger.error(`raw body missing on ${sanitizeForLog(req.url, 64)}`)
      // 400 semantics: raw-body wiring is broken — server configuration error.
      throw Object.assign(new Error('Raw body unavailable'), { status: 400 })
    }

    const signature = (req.headers['x-flashnet-signature'] as string) ?? ''
    const timestamp = (req.headers['x-flashnet-timestamp'] as string) ?? ''

    if (!signature || !timestamp) {
      this.logger.warn(
        `missing HMAC headers (sig=${Boolean(signature)} ts=${Boolean(timestamp)})`,
      )
      throw new UnauthorizedException('Missing HMAC signature headers')
    }

    // Freshness: a captured, correctly signed event cannot be replayed after
    // the window closes (issue 31). Inside the window an exact replay is a
    // no-op through SwapService.applyWebhookEvent's dedupe on
    // (orderId, event, timestamp); the HMAC covers the timestamp, so it cannot
    // be changed to dodge that key.
    if (!isFreshTimestamp(timestamp, Date.now(), this.maxSkewMs)) {
      this.logger.warn({
        event: 'flashnet.webhook_stale_timestamp',
        timestampLength: timestamp.length,
      })
      throw new UnauthorizedException('Webhook timestamp out of range')
    }

    // HMAC verification — constant-time comparison inside FlashnetService.
    const valid = this.flashnet.verifyWebhookSignature(
      rawBody,
      signature,
      timestamp,
    )
    if (!valid) {
      this.logger.warn(`invalid HMAC signature (ts=${sanitizeForLog(timestamp, 16)})`)
      throw new UnauthorizedException('Invalid webhook signature')
    }

    // Parse body after HMAC validation.
    let payload: FlashnetWebhookPayload
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as FlashnetWebhookPayload
    } catch (err) {
      this.logger.warn(`webhook body parse error: ${errorForLog(err)}`)
      // Malformed JSON after valid HMAC — unusual; return 204 to stop retries.
      return
    }

    // Stamp the timestamp from the header into the payload so applyWebhookEvent
    // can use it for the dedupe key without trusting the body timestamp.
    payload.timestamp = timestamp

    await this.swapService.applyWebhookEvent(payload)
    // Always return 204 — Flashnet interprets any 2xx as acknowledged.
  }
}
