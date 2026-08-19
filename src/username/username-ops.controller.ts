import {
  Body,
  Controller,
  Get,
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

  /**
   * Read before you act. A grant cannot be revoked — the DTO rejects negative
   * amounts, and taking back an allowance the customer may already have spent
   * has no coherent meaning — so an operator must be able to see the ceiling
   * without spending one to discover it. Same shape the grant returns, so a
   * screen renders one component for both.
   */
  @Get(':pubkey')
  read(@Param('pubkey') pubkey: string): Promise<UsernameInfoResponseDto> {
    return this.usernameService.getUsernameInfoByPubKey(pubkey)
  }

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
