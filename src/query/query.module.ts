import { Module } from '@nestjs/common'
import { QueryController } from './query.controller'
import { QueryService } from './query.service'
import { PrismaService } from '../prisma/prisma.service'
import { ConfigModule } from '@nestjs/config'

@Module({
  imports: [ConfigModule],
  controllers: [QueryController],
  providers: [QueryService, PrismaService],
  exports: [QueryService],
})
export class QueryModule {}
