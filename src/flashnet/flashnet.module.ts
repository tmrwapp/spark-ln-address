import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { FlashnetService } from './flashnet.service';
import { FlashnetMockService } from './flashnet.mock';

/**
 * Injection token for the Flashnet service.
 * Consumers (e.g. SwapModule) inject via @Inject(FLASHNET_SERVICE).
 */
export const FLASHNET_SERVICE = 'FLASHNET_SERVICE';

/**
 * FlashnetModule provides the Flashnet HTTP client or its mock equivalent.
 *
 * Factory selection:
 *   - FLASHNET_API_KEY is set  → FlashnetService (real HTTP client)
 *   - FLASHNET_API_KEY absent  → FlashnetMockService (deterministic mock)
 *
 * Do NOT import this module in AppModule directly. PR5 (SwapModule) will
 * import it when SwapService actually consumes FlashnetService.
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
        const apiKey = config.get<string>('FLASHNET_API_KEY');
        if (apiKey) {
          return real;
        }
        return mock;
      },
    },
  ],
  exports: [FLASHNET_SERVICE],
})
export class FlashnetModule {}
