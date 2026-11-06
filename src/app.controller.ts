import { Controller, Get } from '@nestjs/common'
import { SkipThrottle } from '@nestjs/throttler'

@Controller()
export class AppController {
  @Get('health')
  @SkipThrottle({ default: true, route: true })
  getHealth() {
    return { status: 'ok', timestamp: new Date().toISOString() }
  }
}
