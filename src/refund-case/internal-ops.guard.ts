import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { timingSafeEqual } from 'crypto'
import type { Request } from 'express'

@Injectable()
export class InternalOpsGuard implements CanActivate {
  private readonly logger = new Logger(InternalOpsGuard.name)
  private readonly tokenBuffer: Buffer | null

  constructor(configService: ConfigService) {
    const token = configService.get<string>('INTERNAL_OPS_TOKEN') ?? ''

    if (!token) {
      this.logger.warn(
        'INTERNAL_OPS_TOKEN is empty or unset — InternalOpsGuard will reject ALL requests. ' +
          'Set INTERNAL_OPS_TOKEN in your environment to enable the ops endpoints.',
      )
      this.tokenBuffer = null
    } else {
      this.tokenBuffer = Buffer.from(token, 'utf8')
    }
  }

  canActivate(context: ExecutionContext): boolean {
    // Fail-closed: no token configured means every request is rejected.
    if (this.tokenBuffer === null) {
      throw new UnauthorizedException('Ops endpoint is not configured')
    }

    const req = context.switchToHttp().getRequest<Request>()
    const authHeader = req.headers['authorization'] as string | undefined

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed Authorization header')
    }

    const providedToken = authHeader.slice(7) // strip "Bearer "
    if (!providedToken) {
      throw new UnauthorizedException('Missing bearer token')
    }

    const providedBuffer = Buffer.from(providedToken, 'utf8')

    // Length must match before timingSafeEqual (which requires equal-length buffers).
    if (providedBuffer.length !== this.tokenBuffer.length) {
      throw new UnauthorizedException('Invalid token')
    }

    if (!timingSafeEqual(providedBuffer, this.tokenBuffer)) {
      throw new UnauthorizedException('Invalid token')
    }

    return true
  }
}
