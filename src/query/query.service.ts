import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { normalizeUsername } from '../common/utils'

@Injectable()
export class QueryService {
  constructor(private readonly prisma: PrismaService) {}

  async findLightningNameByPubKey(pubKeyHex: string) {
    // We assume the pubkey in the DB might be compressed or uncompressed
    // but linkingPubKeyHex is unique, so we search for exactly what is provided.
    // In LNURL-Auth, the 'key' provided in callback is usually what's stored.
    return this.prisma.lightningName.findFirst({
      where: {
        linkingPubKeyHex: pubKeyHex,
        active: true,
      },
    })
  }

  async findLightningNameByUsername(rawUsername: string) {
    const username = normalizeUsername(rawUsername)
    return this.prisma.lightningName.findFirst({
      where: {
        username,
        active: true,
      },
    })
  }
}
