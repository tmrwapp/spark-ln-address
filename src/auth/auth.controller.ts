import { Controller, Get, Query } from '@nestjs/common'
import { AuthService } from './auth.service'
import { LnurlAuthChallengeDto } from '../common/lnurl-auth-challenge.dto'

@Controller('v1/auth/lnurl')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get()
  async getAuthChallenge(): Promise<LnurlAuthChallengeDto> {
    const { k1, callback } = await this.authService.generateAuthChallenge()

    return {
      tag: 'login',
      k1,
      callback,
    }
  }

  @Get('callback')
  async handleAuthCallback(
    @Query('k1') k1: string,
    @Query('sig') sig: string,
    @Query('key') key: string,
    @Query('username') username: string,
  ) {
    return this.authService.verifyAndBindUsername(k1, sig, key, username)
  }
}





