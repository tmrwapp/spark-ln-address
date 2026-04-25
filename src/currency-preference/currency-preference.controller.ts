import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common'
import { User } from '@prisma/client'
import { SparkSignatureGuard } from '../auth/spark-signature.guard'
import { AuthUser } from '../auth/auth-user.decorator'
import { CurrencyPreferenceService } from './currency-preference.service'
import { SetCurrencyPreferenceDto } from './dto/set-currency-preference.dto'
import { CurrencyPreferenceResponseDto } from './dto/currency-preference-response.dto'

// NOTE: Replay-protection LRU is deliberately deferred for this PR.
// Currency preference is idempotent (replaying a PATCH with the same signed body
// re-sets the same value with no side-effect escalation). The 60-second skew window
// keeps the replay surface acceptably small. We should later revisit if the attack surface
// grows (e.g. state-mutating endpoints with financial consequence).

@Controller('v1/users/me')
@UseGuards(SparkSignatureGuard)
export class CurrencyPreferenceController {
  constructor(private readonly currencyPreferenceService: CurrencyPreferenceService) {}

  @Get('currency')
  getCurrency(@AuthUser() user: User): Promise<CurrencyPreferenceResponseDto> {
    return this.currencyPreferenceService.getPreference(user.id)
  }

  @Patch('currency')
  @UsePipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  )
  setCurrency(
    @AuthUser() user: User,
    @Body() dto: SetCurrencyPreferenceDto,
  ): Promise<CurrencyPreferenceResponseDto> {
    return this.currencyPreferenceService.setPreference(user.id, dto.currency)
  }
}
