import { Module } from '@nestjs/common'
import { FlashnetModule } from '../flashnet/flashnet.module'
import { PrismaService } from '../prisma/prisma.service'
import { RefundCaseModule } from '../refund-case/refund-case.module'
import { SwapService } from './swap.service'
import { FlashnetWebhookController } from './flashnet-webhook.controller'

@Module({
  imports: [FlashnetModule, RefundCaseModule],
  controllers: [FlashnetWebhookController],
  providers: [SwapService, PrismaService],
  exports: [SwapService],
})
export class SwapModule {}
