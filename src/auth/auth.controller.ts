import { BadRequestException, Controller, Get, Query } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import {
  ROUTE_LIMITS,
  ROUTE_THROTTLER,
} from '../rate-limit/rate-limit.constants'
import { AuthService } from './auth.service'
import { LnurlAuthChallengeDto } from '../common/lnurl-auth-challenge.dto'

@Controller('v1/auth/lnurl')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get()
  @Throttle({ [ROUTE_THROTTLER]: ROUTE_LIMITS.authChallenge })
  async getAuthChallenge(): Promise<LnurlAuthChallengeDto> {
    const { k1, callback } = await this.authService.generateAuthChallenge()

    return {
      tag: 'login',
      k1,
      callback,
    }
  }

  @Get('callback')
  @Throttle({ [ROUTE_THROTTLER]: ROUTE_LIMITS.authCallback })
  async handleAuthCallback(
    @Query('k1') k1: string,
    @Query('sig') sig: string,
    @Query('key') key: string,
    @Query('username') username: string,
  ) {
    if (!username) {
      throw new BadRequestException({
        status: 'ERROR',
        reason: 'Username is required',
      })
    }

    if (!k1) {
      throw new BadRequestException({
        status: 'ERROR',
        reason: 'k1 is required',
      })
    }

    if (!sig) {
      throw new BadRequestException({
        status: 'ERROR',
        reason: 'sig is required',
      })
    }

    if (!key) {
      throw new BadRequestException({
        status: 'ERROR',
        reason: 'linking key is required',
      })
    }

    return this.authService.verifyAndBindUsername(k1, sig, key, username)
  }
}
