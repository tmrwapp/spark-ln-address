import { IsEnum } from 'class-validator'
import { ReceivingCurrency } from '@prisma/client'

export class SetCurrencyPreferenceDto {
  @IsEnum(ReceivingCurrency)
  currency: ReceivingCurrency
}
