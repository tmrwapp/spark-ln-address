import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service'
import { normalizeUsername, getDomainFromBaseUrl } from '../common/utils'
import { encodeSparkAddress, SparkNetwork } from '../common/spark-address.utils'
import { UsernameQueryResponseDto } from '../common/username-query-response.dto'
import { PubKeyQueryResponseDto } from '../common/pubkey-query-response.dto'

@Injectable()
export class QueryService {
  private readonly logger = new Logger(QueryService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

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
    return this.prisma.lightningName.findMany({
      where: {
        username: {
          contains: username,
        },
        active: true,
      },
    })
  }

  async queryByPubKey(pubKey: string): Promise<UsernameQueryResponseDto | null> {
    this.logger.log(`Querying by pubKey: [${pubKey}]`)
    const lightningName = await this.findLightningNameByPubKey(pubKey)
    if (!lightningName) {
      return null
    }

    const publicBaseUrl = this.configService.get<string>('PUBLIC_BASE_URL')
    if (!publicBaseUrl) {
      throw new Error('PUBLIC_BASE_URL not configured')
    }

    const domain = getDomainFromBaseUrl(publicBaseUrl)
    const lightningAddress = `${lightningName.username}@${domain}`

    // Construct Spark Address
    // Note: In a real scenario, we might want to fetch the network from config
    // LightsparkService uses 'MAINNET' by default.
    const network = (this.configService.get<string>('SPARK_NETWORK') || 'MAINNET') as SparkNetwork

    let sparkAddress = ''
    try {
      sparkAddress = await encodeSparkAddress(lightningName.linkingPubKeyHex, network)
    } catch (error) {
      this.logger.error(`Error encoding spark address: ${error.message}`)
      // We still return the response but without sparkAddress if it fails for some reason
      // though ideally linkingPubKeyHex is always valid if it's in the DB
    }

    return {
      username: lightningName.username,
      lightningAddress,
      sparkAddress,
      publicKey: lightningName.linkingPubKeyHex,
    }
  }

  async queryByUsername(username: string): Promise<PubKeyQueryResponseDto[]> {
    this.logger.log(`Querying by username: [${username}]`)
    const lightningNames = await this.findLightningNameByUsername(username)
    if (!lightningNames.length) {
      return []
    }

    const publicBaseUrl = this.configService.get<string>('PUBLIC_BASE_URL')
    if (!publicBaseUrl) {
      throw new Error('PUBLIC_BASE_URL not configured')
    }

    const domain = getDomainFromBaseUrl(publicBaseUrl)
    const network = (this.configService.get<string>('SPARK_NETWORK') || 'MAINNET') as SparkNetwork

    const results = await Promise.all(
      lightningNames.map(async (lightningName) => {
        const lightningAddress = `${lightningName.username}@${domain}`
        let sparkAddress = ''
        try {
          sparkAddress = await encodeSparkAddress(lightningName.linkingPubKeyHex, network)
        } catch (error) {
          this.logger.error(`Error encoding spark address: ${error.message}`)
        }

        return {
          username: lightningName.username,
          lightningAddress,
          sparkAddress,
          publicKey: lightningName.linkingPubKeyHex,
        }
      }),
    )

    return results
  }
}
