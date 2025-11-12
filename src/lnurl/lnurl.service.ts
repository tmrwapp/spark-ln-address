import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { normalizeUsername } from '../common/utils'

@Injectable()
export class LnurlService {
  constructor(private readonly prisma: PrismaService) {}

  async findActiveLightningName(rawUsername: string) {
    const username = normalizeUsername(rawUsername)
    return this.prisma.lightningName.findFirst({
      where: {
        username,
        active: true,
      },
    })
  }

  async createInvoice(data: {
    usernameId: string
    amountMsat: bigint
    bolt11: string
    expiresAt: Date
  }) {
    return this.prisma.invoice.create({
      data,
    })
  }
}
