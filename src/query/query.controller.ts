import {
  Controller,
  Get,
  Param,
  NotFoundException,
} from '@nestjs/common'
import { QueryService } from 'src/query/query.service'
import { UsernameQueryResponseDto } from 'src/common/username-query-response.dto'
import { PubKeyQueryResponseDto } from 'src/common/pubkey-query-response.dto'

@Controller('v1/query')
export class QueryController {
  constructor(
    private readonly queryService: QueryService,
  ) {}

  @Get('username/:pubKey')
  async queryByPubKey(
    @Param('pubKey') pubKey: string,
  ): Promise<UsernameQueryResponseDto> {
    const result = await this.queryService.queryByPubKey(pubKey)
    if (!result) {
      throw new NotFoundException('No active username found for this public key')
    }
    return result
  }

  @Get('pubkey/:username')
  async queryByUsername(
    @Param('username') username: string,
  ): Promise<PubKeyQueryResponseDto[]> {
    return this.queryService.queryByUsername(username)
  }
}
