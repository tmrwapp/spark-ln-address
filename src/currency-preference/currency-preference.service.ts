import { Injectable, Logger } from '@nestjs/common'
import { ReceivingCurrency } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { CurrencyPreferenceResponseDto } from './dto/currency-preference-response.dto'

@Injectable()
export class CurrencyPreferenceService {
  private readonly logger = new Logger(CurrencyPreferenceService.name)

  constructor(private readonly prisma: PrismaService) {}

  async getPreference(userId: string): Promise<CurrencyPreferenceResponseDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { defaultReceivingCurrency: true, updatedAt: true },
    })
    return { currency: user.defaultReceivingCurrency, updatedAt: user.updatedAt }
  }

  async setPreference(
    userId: string,
    currency: ReceivingCurrency,
  ): Promise<CurrencyPreferenceResponseDto> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { defaultReceivingCurrency: currency },
      select: { defaultReceivingCurrency: true, updatedAt: true },
    })
    this.logger.log({ event: 'currency_preference.set', userId, currency })
    return { currency: user.defaultReceivingCurrency, updatedAt: user.updatedAt }
  }
}
