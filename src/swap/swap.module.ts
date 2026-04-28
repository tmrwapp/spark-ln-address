import { Module } from '@nestjs/common'
import { FlashnetModule } from '../flashnet/flashnet.module'
import { PrismaService } from '../prisma/prisma.service'
import { SwapService } from './swap.service'

@Module({
  imports: [FlashnetModule],
  providers: [SwapService, PrismaService],
  exports: [SwapService],
})
export class SwapModule {}
