import { Module } from '@nestjs/common'
import { LnurlController } from './lnurl.controller'
import { LnurlService } from './lnurl.service'
import { LightsparkService } from '../lightspark/lightspark.service'
import { PrismaService } from '../prisma/prisma.service'
import { SwapModule } from '../swap/swap.module'

@Module({
  imports: [SwapModule],
  controllers: [LnurlController],
  providers: [LnurlService, LightsparkService, PrismaService],
})
export class LnurlModule {}
