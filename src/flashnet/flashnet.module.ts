import { Logger, Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { FlashnetService } from './flashnet.service'
import { FlashnetMockService } from './flashnet.mock'
import { isTestEnvironment } from './flashnet-environment'

/**
 * Injection token for the Flashnet service.
 * Consumers (e.g. SwapModule) inject via @Inject(FLASHNET_SERVICE).
 */
export const FLASHNET_SERVICE = 'FLASHNET_SERVICE'

const logger = new Logger('FlashnetModule')

/**
 * FlashnetModule provides the Flashnet HTTP client or its mock equivalent.
 *
 * Factory selection:
 *   - NODE_ENV=test and FLASHNET_API_KEY absent → FlashnetMockService
 *   - anything else                             → FlashnetService (real client)
 *
 * Outside tests a missing FLASHNET_API_KEY is logged loudly and the real
 * client is used anyway: quote calls then fail and the LNURL callback falls
 * back to a sats invoice, and webhooks are verified for real. The mock is
 * never used outside tests because it accepts every webhook signature
 * (issue 31).
 */
@Module({
  imports: [ConfigModule],
  providers: [
    FlashnetService,
    FlashnetMockService,
    {
      provide: FLASHNET_SERVICE,
      inject: [ConfigService, FlashnetService, FlashnetMockService],
      useFactory: (
        config: ConfigService,
        real: FlashnetService,
        mock: FlashnetMockService,
      ) => {
        const apiKey = config.get<string>('FLASHNET_API_KEY')
        if (apiKey) {
          return real
        }
        if (isTestEnvironment()) {
          return mock
        }
        logger.error(
          { event: 'flashnet.api_key_missing' },
          'FLASHNET_API_KEY is not set: USDB quotes will fail and fall back to sats',
        )
        return real
      },
    },
  ],
  exports: [FLASHNET_SERVICE],
})
export class FlashnetModule {}
