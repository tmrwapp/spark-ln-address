import {
  Body,
  Controller,
  Param,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common'
import { InternalOpsGuard } from '../refund-case/internal-ops.guard'
import { UsernameService } from './username.service'
import { GrantUsernameChangesDto } from './dto/grant-username-changes.dto'
import { UsernameInfoResponseDto } from './dto/username-response.dto'

/**
 * Support-only surface for granting a user extra username changes.
 *
 * Users are addressed by their linking public key because that is the
 * identifier support can obtain from the customer and from the public query
 * endpoints. The internal User.id is not exposed anywhere today and is not
 * exposed here either.
 */
@Controller('v1/internal/username-changes')
@UseGuards(InternalOpsGuard)
export class UsernameOpsController {
  constructor(private readonly usernameService: UsernameService) {}

  @Post(':pubkey/grant')
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  )
  grant(
    @Param('pubkey') pubkey: string,
    @Body() dto: GrantUsernameChangesDto,
  ): Promise<UsernameInfoResponseDto> {
    return this.usernameService.grantExtraChanges(
      pubkey,
      dto.amount,
      dto.reason,
    )
  }
}
