import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { PrismaService } from '../prisma/prisma.service'
import { InternalOpsGuard } from '../refund-case/internal-ops.guard'
import { UsernameController } from './username.controller'
import { UsernameOpsController } from './username-ops.controller'
import { UsernameService } from './username.service'

@Module({
  imports: [AuthModule],
  controllers: [UsernameController, UsernameOpsController],
  providers: [UsernameService, InternalOpsGuard, PrismaService],
  exports: [UsernameService],
})
export class UsernameModule {}
