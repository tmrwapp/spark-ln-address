import {
  Controller,
  Get,
  Param,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { QueryService } from 'src/query/query.service'
import { getDomainFromBaseUrl } from 'src/common/utils'
import { encodeSparkAddress, SparkNetwork } from 'src/common/spark-address.utils'
import { UsernameQueryResponseDto } from 'src/common/username-query-response.dto'
import { PubKeyQueryResponseDto } from 'src/common/pubkey-query-response.dto'

@Controller('v1/query')
export class QueryController {
  private readonly logger = new Logger(QueryController.name)

  constructor(
    private readonly queryService: QueryService,
    private readonly configService: ConfigService,
  ) {}

  @Get('username/:pubKey')
  async queryByPubKey(
    @Param('pubKey') pubKey: string,
  ): Promise<UsernameQueryResponseDto> {
    const lightningName = await this.queryService.findLightningNameByPubKey(pubKey)
    if (!lightningName) {
      throw new NotFoundException('No active username found for this public key')
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

  @Get('pubkey/:username')
  async queryByUsername(
    @Param('username') username: string,
  ): Promise<PubKeyQueryResponseDto[]> {
    this.logger.log(`Querying by username: ${username}`)
    const lightningNames = await this.queryService.findLightningNameByUsername(username)
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
