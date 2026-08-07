import { IsString, MaxLength, MinLength } from 'class-validator'

export class ChangeUsernameDto {
  /**
   * Requested username. Format is enforced by normalizeUsername in the service;
   * the bounds here only reject payloads that are obviously not usernames before
   * they reach the database.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  username: string
}
