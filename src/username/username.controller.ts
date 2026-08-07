import {
  Body,
  Controller,
  Get,
  Patch,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common'
import { User } from '@prisma/client'
import { AuthUser } from '../auth/auth-user.decorator'
import { SparkSignatureGuard } from '../auth/spark-signature.guard'
import { UsernameService } from './username.service'
import { ChangeUsernameDto } from './dto/change-username.dto'
import {
  ChangeUsernameResponseDto,
  UsernameInfoResponseDto,
} from './dto/username-response.dto'

// Unlike the currency-preference endpoints, PATCH here is NOT idempotent: a
// replayed request would spend a second unit of the change quota, and once the
// quota is exhausted it would silently flip the user's active name. The replay
// cache in SparkSignatureGuard is what makes this endpoint safe to expose.
@Controller('v1/users/me/username')
@UseGuards(SparkSignatureGuard)
export class UsernameController {
  constructor(private readonly usernameService: UsernameService) {}

  @Get()
  getUsername(@AuthUser() user: User): Promise<UsernameInfoResponseDto> {
    return this.usernameService.getUsernameInfo(user.id)
  }

  @Patch()
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  )
  changeUsername(
    @AuthUser() user: User,
    @Body() dto: ChangeUsernameDto,
  ): Promise<ChangeUsernameResponseDto> {
    return this.usernameService.changeUsername(user.id, dto.username)
  }
}
