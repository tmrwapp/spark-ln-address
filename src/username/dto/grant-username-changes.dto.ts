import { IsInt, IsString, Max, Min, MinLength } from 'class-validator'
import { MAX_GRANT_PER_CALL } from '../username.constants'

export class GrantUsernameChangesDto {
  /**
   * Extra username changes to add to the user's ceiling. Capped so a typo cannot
   * hand out an unbounded allowance in a single call.
   */
  @IsInt()
  @Min(1)
  @Max(MAX_GRANT_PER_CALL)
  amount: number

  /**
   * Why the grant was given. There is no audit table, so this ends up in the
   * structured log and is the only record of the decision.
   */
  @IsString()
  @MinLength(1)
  reason: string
}
