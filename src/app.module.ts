import { Module } from '@nestjs/common'
import { AppController } from './app.controller'
import { ConfigModule } from './config/config.module'
import { PrismaService } from './prisma/prisma.service'
import { LnurlModule } from './lnurl/lnurl.module'
import { AuthModule } from './auth/auth.module'
import { QueryModule } from 'src/query/query.module'
import { CurrencyPreferenceModule } from './currency-preference/currency-preference.module'
import { SwapModule } from './swap/swap.module'

@Module({
  imports: [ConfigModule, LnurlModule, AuthModule, QueryModule, CurrencyPreferenceModule, SwapModule],
  controllers: [AppController],
  providers: [PrismaService],
})
export class AppModule {}
