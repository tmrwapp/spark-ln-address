import { Module } from '@nestjs/common'
import { AppController } from './app.controller'
import { ConfigModule } from './config/config.module'
import { PrismaService } from './prisma/prisma.service'
import { LnurlModule } from './lnurl/lnurl.module'
import { AuthModule } from './auth/auth.module'

@Module({
  imports: [ConfigModule, LnurlModule, AuthModule],
  controllers: [AppController],
  providers: [PrismaService],
})
export class AppModule {}
