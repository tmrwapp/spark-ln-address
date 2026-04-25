import { ReceivingCurrency } from '@prisma/client'

export class CurrencyPreferenceResponseDto {
  currency: ReceivingCurrency
  updatedAt: Date
}
