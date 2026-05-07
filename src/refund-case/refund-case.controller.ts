import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
  ParseIntPipe,
  DefaultValuePipe,
  NotFoundException,
} from '@nestjs/common'
import { InternalOpsGuard } from './internal-ops.guard'
import { RefundCaseService } from './refund-case.service'
import { MarkPaidDto } from './dto/mark-paid.dto'
import { MarkAbandonedDto } from './dto/mark-abandoned.dto'

@Controller('v1/internal/refund-cases')
@UseGuards(InternalOpsGuard)
export class RefundCaseController {
  constructor(private readonly refundCaseService: RefundCaseService) {}

  /**
   * GET /v1/internal/refund-cases?limit=&offset=
   * Returns a paginated list of OPEN refund cases.
   */
  @Get()
  listOpen(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.refundCaseService.listOpenRefundCases({ limit, offset })
  }

  /**
   * GET /v1/internal/refund-cases/:id
   * Returns a single RefundCase or 404.
   */
  @Get(':id')
  async findOne(@Param('id') id: string) {
    const found = await this.refundCaseService.findById(id)
    if (!found) {
      throw new NotFoundException(`RefundCase ${id} not found`)
    }
    return found
  }

  /**
   * PATCH /v1/internal/refund-cases/:id/paid
   * Body: { externalRef?: string; payeeLnAddress?: string }
   */
  @Patch(':id/paid')
  @UsePipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  )
  markPaid(@Param('id') id: string, @Body() dto: MarkPaidDto) {
    return this.refundCaseService.markPaid(id, {
      externalRef: dto.externalRef,
      payeeLnAddress: dto.payeeLnAddress,
    })
  }

  /**
   * PATCH /v1/internal/refund-cases/:id/abandoned
   * Body: { reason?: string }
   */
  @Patch(':id/abandoned')
  @UsePipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  )
  markAbandoned(@Param('id') id: string, @Body() dto: MarkAbandonedDto) {
    return this.refundCaseService.markAbandoned(id, { reason: dto.reason })
  }
}
