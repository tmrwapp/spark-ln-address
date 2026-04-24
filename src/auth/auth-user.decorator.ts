import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common'
import type { Request } from 'express'

/**
 * Param decorator that extracts the authenticated user from the request.
 * Must only be used on handlers protected by SparkSignatureGuard.
 * Throws InternalServerErrorException (fails loud) if user is not set.
 */
export const AuthUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<Request>()
  if (!req.user) {
    throw new InternalServerErrorException(
      '@AuthUser() used on a handler not protected by SparkSignatureGuard',
    )
  }
  return req.user
})
