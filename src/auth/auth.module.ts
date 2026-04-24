import { Module } from '@nestjs/common'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { PrismaService } from '../prisma/prisma.service'
import { SparkSignatureGuard } from './spark-signature.guard'

@Module({
  controllers: [AuthController],
  providers: [AuthService, PrismaService, SparkSignatureGuard],
  exports: [SparkSignatureGuard],
})
export class AuthModule {}
