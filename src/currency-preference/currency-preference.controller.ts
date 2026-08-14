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

// NOTE: SparkSignatureGuard applies replay rejection to every method it does
// not exempt, so the PATCH below is covered even though it does not need to be:
// re-setting the same preference is a no-op. The practical consequence is that
// a client must re-sign to retry it, rather than resending the same headers.
// The GET is exempt, so retrying a read is not mistaken for a replay.

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
