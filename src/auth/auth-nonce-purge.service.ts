import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

/** Delay before the first run after boot. */
const PURGE_FIRST_RUN_MS = 30 * 1000
/** How often the purge runs. */
const PURGE_INTERVAL_MS = 10 * 60 * 1000
/** Expired nonces are kept this long for debugging, then deleted. */
const PURGE_GRACE_MS = 60 * 60 * 1000
/** Rows deleted per statement, so a large backlog never locks the table long. */
const PURGE_BATCH_SIZE = 1000
/** Safety bound on batches per run. */
const PURGE_MAX_BATCHES = 1000

/**
 * Deletes expired LNURL-auth nonces (issue 30). Every GET /v1/auth/lnurl
 * inserts a row and nothing else removes them. A nonce is useless once
 * expired: the callback rejects it, so deleting it changes no behaviour.
 */
@Injectable()
export class AuthNoncePurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthNoncePurgeService.name)
  private timer: NodeJS.Timeout | undefined
  private firstRun: NodeJS.Timeout | undefined
  private running = false

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return
    }
    // First run shortly after boot, so frequent restarts never skip it.
    this.firstRun = setTimeout(() => void this.runSafely(), PURGE_FIRST_RUN_MS)
    this.firstRun.unref()
    this.timer = setInterval(() => void this.runSafely(), PURGE_INTERVAL_MS)
    this.timer.unref()
  }

  onModuleDestroy(): void {
    if (this.firstRun) {
      clearTimeout(this.firstRun)
      this.firstRun = undefined
    }
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Deletes nonces that expired before `now - grace`; returns the count. */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - PURGE_GRACE_MS)
    let deleted = 0
    for (let batch = 0; batch < PURGE_MAX_BATCHES; batch++) {
      const rows = await this.prisma.authNonce.findMany({
        where: { expiresAt: { lt: cutoff } },
        select: { id: true },
        take: PURGE_BATCH_SIZE,
      })
      if (rows.length === 0) {
        break
      }
      const result = await this.prisma.authNonce.deleteMany({
        where: { id: { in: rows.map((row) => row.id) } },
      })
      deleted += result.count
      if (rows.length < PURGE_BATCH_SIZE) {
        break
      }
    }
    return deleted
  }

  private async runSafely(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    try {
      const deleted = await this.purgeExpired()
      if (deleted > 0) {
        this.logger.log({ event: 'auth_nonce.purged', deleted })
      }
    } catch (error) {
      this.logger.warn({
        event: 'auth_nonce.purge_failed',
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      })
    } finally {
      this.running = false
    }
  }
}
