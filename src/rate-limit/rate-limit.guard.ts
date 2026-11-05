import {
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common'
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler'

/**
 * ThrottlerGuard that answers in the LNURL error shape. LUD-04/LUD-06 wallets
 * read `{ status: 'ERROR', reason }` from the body, so a bare 429 would be
 * shown to the user as an unknown failure. A standard Retry-After header is
 * set too (the base guard only sets a throttler-suffixed one for named
 * throttlers).
 */
@Injectable()
export class LnurlThrottlerGuard extends ThrottlerGuard {
  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const { res } = this.getRequestResponse(context)
    res.header('Retry-After', String(Math.max(1, detail.timeToBlockExpire)))
    throw new HttpException(
      { status: 'ERROR', reason: 'Too many requests, retry later' },
      HttpStatus.TOO_MANY_REQUESTS,
    )
  }
}
