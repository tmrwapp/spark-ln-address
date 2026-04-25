import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { PrismaService } from '../prisma/prisma.service'
import { CurrencyPreferenceController } from './currency-preference.controller'
import { CurrencyPreferenceService } from './currency-preference.service'

@Module({
  imports: [AuthModule],
  controllers: [CurrencyPreferenceController],
  providers: [CurrencyPreferenceService, PrismaService],
  exports: [CurrencyPreferenceService],
})
export class CurrencyPreferenceModule {}
