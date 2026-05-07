import { Module } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { InternalOpsGuard } from './internal-ops.guard'
import { RefundCaseController } from './refund-case.controller'
import { RefundCaseService } from './refund-case.service'

@Module({
  imports: [],
  controllers: [RefundCaseController],
  providers: [RefundCaseService, InternalOpsGuard, PrismaService],
  exports: [RefundCaseService],
})
export class RefundCaseModule {}
