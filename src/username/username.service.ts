import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { LightningName } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { getDomainFromBaseUrl, normalizeUsername } from '../common/utils'
import { DEFAULT_NEW_NAME_ALLOWANCE } from './username.constants'
import {
  ChangeUsernameResponseDto,
  UsernameInfoResponseDto,
} from './dto/username-response.dto'

/**
 * Prisma unique-constraint violation. Checked structurally rather than with
 * `instanceof Prisma.PrismaClientKnownRequestError` so the branch stays
 * reachable when PrismaService is mocked in unit tests.
 */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'P2002'
}

function isUniqueViolationOn(error: unknown, column: string): boolean {
  if (!isUniqueViolation(error)) {
    return false
  }
  const err = error as { meta?: { target?: unknown } }
  const target = err.meta?.target
  const rendered = Array.isArray(target)
    ? target.join(',')
    : String(target ?? '')
  return rendered.includes(column)
}

@Injectable()
export class UsernameService {
  private readonly logger = new Logger(UsernameService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Returns the active name, the user's full name history and the remaining
   * change quota. The quota fields are authoritative: a support grant raises the
   * ceiling for one user only, so clients must not assume the default allowance.
   */
  async getUsernameInfo(userId: string): Promise<UsernameInfoResponseDto> {
    const { rows, active, changesLimit } = await this.loadState(userId)

    return {
      ...this.buildQuota(rows, changesLimit),
      username: active.username,
      lightningAddress: this.toLightningAddress(active.username),
      history: rows.map((row) => ({
        username: row.username,
        active: row.active,
        claimedAt: row.createdAt,
      })),
    }
  }

  /**
   * Moves the user to `rawUsername`, retiring the currently active name.
   *
   * Re-activating a name the user already owns is free and always permitted.
   * Claiming a name nobody has ever owned consumes one unit of quota and is
   * rejected once the ceiling is reached. A retired name stays occupied in the
   * `username` unique index forever, so it can never be claimed by anyone else.
   */
  async changeUsername(
    userId: string,
    rawUsername: string,
  ): Promise<ChangeUsernameResponseDto> {
    let username: string
    try {
      username = normalizeUsername(rawUsername)
    } catch (error) {
      throw new BadRequestException({
        code: 'INVALID_USERNAME',
        message: error instanceof Error ? error.message : 'Invalid username',
      })
    }

    const { rows, active, changesLimit } = await this.loadState(userId)

    if (active.username === username) {
      throw new BadRequestException({
        code: 'SAME_USERNAME',
        message: 'This is already your Lightning username',
      })
    }

    const owned = rows.find((row) => row.username === username)

    if (!owned) {
      if (rows.length - 1 >= changesLimit) {
        throw new ConflictException({
          code: 'CHANGE_LIMIT_REACHED',
          message: 'No username changes left on this account',
        })
      }

      // Advisory check so the common case returns a clean 409 instead of
      // surfacing a constraint violation. The transaction below is what actually
      // closes the race.
      const taken = await this.prisma.lightningName.findUnique({
        where: { username },
      })
      if (taken) {
        // Rows were read before this check, so a name owned by this account can
        // only have been claimed by a concurrent request for the same change.
        if (taken.userId === userId) {
          const converged = await this.convergedResponse(
            userId,
            username,
            false,
          )
          if (converged) {
            return converged
          }
        }
        throw new ConflictException({
          code: 'USERNAME_TAKEN',
          message: 'This username is not available',
        })
      }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // Deactivate first: the activePubKey unique index would reject a second
        // active row for this pubkey if the order were reversed.
        await tx.lightningName.update({
          where: { id: active.id },
          data: { active: false, activePubKey: null },
        })

        if (owned) {
          await tx.lightningName.update({
            where: { id: owned.id },
            data: { active: true, activePubKey: owned.linkingPubKeyHex },
          })
          return
        }

        await tx.lightningName.create({
          data: {
            username,
            userId,
            linkingPubKeyHex: active.linkingPubKeyHex,
            active: true,
            activePubKey: active.linkingPubKeyHex,
          },
        })
      })
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error
      }

      const converged = await this.convergedResponse(
        userId,
        username,
        Boolean(owned),
      )
      if (converged) {
        return converged
      }

      if (isUniqueViolationOn(error, 'username')) {
        throw new ConflictException({
          code: 'USERNAME_TAKEN',
          message: 'This username is not available',
        })
      }

      // The winning request moved this account to a different name, so its new
      // active row already holds the pubkey this one tried to claim.
      if (isUniqueViolationOn(error, 'activePubKey')) {
        throw new ConflictException({
          code: 'CHANGE_IN_PROGRESS',
          message:
            'Another username change for this account was processed first',
        })
      }

      throw error
    }

    const rowsAfter = owned ? rows : [...rows, null]

    this.logger.log({
      event: 'username.changed',
      userId,
      from: active.username,
      to: username,
      switchedBack: Boolean(owned),
    })

    return {
      ...this.buildQuota(rowsAfter, changesLimit),
      username,
      lightningAddress: this.toLightningAddress(username),
      switchedBack: Boolean(owned),
    }
  }

  /**
   * Re-reads state after a conflict and returns the normal success response if
   * the account is already on `username`.
   *
   * `loadState` runs outside the transaction, so two requests for one account
   * can both pass the checks before either commits. The loser then collides on
   * `username` or on `activePubKey` depending on what the winner did — but if
   * the winner made the change this request was asking for, the caller's intent
   * is satisfied and an error would be false. It would also be harmful: a client
   * told "this username is not available" about the name it just got will send
   * the user to pick another one, spending a second unit of quota to end up
   * somewhere they never asked to be.
   *
   * Returns null when the account landed somewhere else, which is a real
   * conflict for the caller to report.
   */
  private async convergedResponse(
    userId: string,
    username: string,
    switchedBack: boolean,
  ): Promise<ChangeUsernameResponseDto | null> {
    const { rows, active, changesLimit } = await this.loadState(userId)
    if (active.username !== username) {
      return null
    }

    this.logger.log({
      event: 'username.change_converged',
      userId,
      to: username,
    })

    return {
      ...this.buildQuota(rows, changesLimit),
      username,
      lightningAddress: this.toLightningAddress(username),
      switchedBack,
    }
  }

  /**
   * Raises one user's change ceiling. Called by support through the internal ops
   * endpoint; usage is never rewritten, only the ceiling moves.
   */
  /**
   * The same view of a user `getUsernameInfo` returns, addressed by linking
   * public key instead of by internal user id.
   *
   * This is the read half of the support surface. Without it the quota is
   * visible only as the response to a grant that has already been applied, and
   * a grant cannot be revoked — so an operator checking whether a customer is
   * genuinely at their ceiling had to spend one to find out.
   */
  async getUsernameInfoByPubKey(
    pubKeyHex: string,
  ): Promise<UsernameInfoResponseDto> {
    const active = await this.resolveActiveByPubKey(pubKeyHex)

    return this.getUsernameInfo(active.userId)
  }

  async grantExtraChanges(
    pubKeyHex: string,
    amount: number,
    reason: string,
  ): Promise<UsernameInfoResponseDto> {
    const active = await this.resolveActiveByPubKey(pubKeyHex)

    await this.prisma.user.update({
      where: { id: active.userId },
      data: { bonusUsernameChanges: { increment: amount } },
    })

    this.logger.log({
      event: 'username.changes_granted',
      userId: active.userId,
      username: active.username,
      amount,
      reason,
    })

    return this.getUsernameInfo(active.userId)
  }

  /**
   * The active row for a linking public key, which is what identifies a user on
   * this surface.
   *
   * Lowercased before the lookup: `verifyAndBindUsername` stores
   * `linkingPubKeyHex` exactly as the client sent it, so a user registered with
   * uppercase hex is invisible to an exact-match query. That storage
   * inconsistency is pre-existing and tracked separately; both halves of the
   * ops surface read through here so neither makes it worse, and so a pubkey
   * that resolves for one verb resolves for the other.
   */
  private async resolveActiveByPubKey(
    pubKeyHex: string,
  ): Promise<LightningName> {
    const active = await this.prisma.lightningName.findFirst({
      where: { linkingPubKeyHex: pubKeyHex.toLowerCase(), active: true },
    })

    if (!active) {
      throw new NotFoundException(
        'No active username found for this public key',
      )
    }

    return active
  }

  /**
   * Loads every name the user owns plus their effective ceiling.
   * The active row is required: SparkSignatureGuard only resolves a user through
   * one, so its absence means the data is inconsistent rather than that the
   * caller did something wrong.
   */
  private async loadState(userId: string): Promise<{
    rows: LightningName[]
    active: LightningName
    changesLimit: number
  }> {
    const [rows, user] = await Promise.all([
      this.prisma.lightningName.findMany({
        where: { userId },
        orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
      }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { bonusUsernameChanges: true },
      }),
    ])

    const active = rows.find((row) => row.active)
    if (!active) {
      this.logger.error(`User ${userId} has no active lightning name`)
      throw new NotFoundException('No active username found for this account')
    }

    return {
      rows,
      active,
      changesLimit: DEFAULT_NEW_NAME_ALLOWANCE + user.bonusUsernameChanges,
    }
  }

  /**
   * Usage is derived, never stored: claiming a new name adds a row, switching
   * back only flips flags. A stored counter could drift from the rows; this
   * cannot.
   */
  private buildQuota(
    rows: unknown[],
    changesLimit: number,
  ): { changesUsed: number; changesLimit: number; changesRemaining: number } {
    const changesUsed = Math.max(0, rows.length - 1)
    return {
      changesUsed,
      changesLimit,
      changesRemaining: Math.max(0, changesLimit - changesUsed),
    }
  }

  private toLightningAddress(username: string): string {
    const publicBaseUrl = this.configService.get<string>('PUBLIC_BASE_URL')
    if (!publicBaseUrl) {
      throw new Error('PUBLIC_BASE_URL not configured')
    }
    return `${username}@${getDomainFromBaseUrl(publicBaseUrl)}`
  }
}
