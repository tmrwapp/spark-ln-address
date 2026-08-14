export class UsernameHistoryEntryDto {
  username: string
  active: boolean
  /** When this name was first claimed by the user. */
  claimedAt: Date
}

export class UsernameInfoResponseDto {
  username: string
  lightningAddress: string
  /** New names claimed so far, derived from the row count. */
  changesUsed: number
  /** Ceiling for this user: the default allowance plus any support grant. */
  changesLimit: number
  changesRemaining: number
  /** Every name the user owns, active one first. */
  history: UsernameHistoryEntryDto[]
}

export class ChangeUsernameResponseDto {
  username: string
  lightningAddress: string
  changesUsed: number
  changesLimit: number
  changesRemaining: number
  /** True when the user re-activated a name they already owned, which is free. */
  switchedBack: boolean
}
