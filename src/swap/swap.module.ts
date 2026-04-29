import { Module } from '@nestjs/common'
import { FlashnetModule } from '../flashnet/flashnet.module'
import { PrismaService } from '../prisma/prisma.service'
import { SwapService } from './swap.service'
import { FlashnetWebhookController } from './flashnet-webhook.controller'

@Module({
  imports: [FlashnetModule],
  controllers: [FlashnetWebhookController],
  providers: [SwapService, PrismaService],
  exports: [SwapService],
})
export class SwapModule {}
