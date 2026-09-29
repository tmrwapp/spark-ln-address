import { ConfigModule } from '@nestjs/config'
import { QuoteReconciler } from './quote-reconciler.service'
import { Module } from '@nestjs/common'
import { FlashnetModule } from '../flashnet/flashnet.module'
import { PrismaService } from '../prisma/prisma.service'
import { RefundCaseModule } from '../refund-case/refund-case.module'
import { SwapService } from './swap.service'
import { FlashnetWebhookController } from './flashnet-webhook.controller'

@Module({
  imports: [ConfigModule, FlashnetModule, RefundCaseModule],
  controllers: [FlashnetWebhookController],
  providers: [QuoteReconciler, SwapService, PrismaService],
  exports: [SwapService],
})
export class SwapModule {}
