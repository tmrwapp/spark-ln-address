import { Logger } from '@nestjs/common'

/**
 * Usernames nobody may register or change to (issue 32): brand, support and
 * role names that would let a stranger pose as the company, e.g. `support@`.
 *
 * Extend the list without a code change through the `RESERVED_USERNAMES`
 * config value (comma separated). The check runs on registration and on
 * claiming a new name; names already owned stay valid, see the callers.
 */

export const BRANDS = ['guap', 'tmrw', 'tomorrow', 'guapwallet']

export const ROLES = [
  'admin',
  'app',
  'bot',
  'care',
  'help',
  'hq',
  'info',
  'news',
  'official',
  'ops',
  'pay',
  'payments',
  'security',
  'staff',
  'support',
  'team',
  'wallet',
]

export const STANDALONE = [
  'abuse',
  'admin',
  'administrator',
  'billing',
  'ceo',
  'compliance',
  'contact',
  'customerservice',
  'customersupport',
  'flashnet',
  'help',
  'helpdesk',
  'hostmaster',
  'info',
  'legal',
  'moderator',
  'no-reply',
  'noreply',
  'official',
  'operator',
  'orchestra',
  'payments',
  'postmaster',
  'privacy',
  'refund',
  'refunds',
  'root',
  'security',
  'staff',
  'superuser',
  'support',
  'sysadmin',
  'system',
  'team',
  'verify',
  'verification',
  'webmaster',
]

/**
 * Words that only dress up a protected word (`theguap`, `realsupport`). They
 * are never reserved on their own.
 */
export const FILLERS = ['the', 'real', 'my', 'true', 'original', 'verified']

export const DEFAULT_RESERVED_USERNAMES: readonly string[] = Object.freeze([
  ...new Set([...BRANDS, ...ROLES, ...STANDALONE]),
])

/** Digits and letters commonly swapped in to imitate another name. */
const LOOKALIKES: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  l: 'i',
  '2': 'z',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '6': 'g',
  '7': 't',
  '8': 'b',
  '9': 'g',
  q: 'g',
}

/**
 * Collapses a username to a comparison key, so `Gu4p.Supp0rt`, `trnrw` and
 * `guapsupport`-style names line up with the reserved words:
 * 1. lowercase, separators `._-` removed;
 * 2. multi-letter lookalikes folded (`rn` to `m`, `vv` to `w`);
 * 3. repeated characters collapsed (`suppport`, `guaap`), BEFORE the single
 *    folds, so `billing` does not collapse into `bing`;
 * 4. single lookalikes folded (`0` to `o`, `1` and `l` to `i`, `q` to `g`...).
 * Unicode homoglyphs cannot occur: normalizeUsername allows `[a-z0-9._-]` only.
 */
export function usernameSkeleton(name: string): string {
  return name
    .toLowerCase()
    .replace(/[._-]/g, '')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/(.)\1+/g, '$1')
    .replace(/[0-9lq]/g, (c) => LOOKALIKES[c] ?? c)
}

/**
 * The skeletons to test for one name: as typed, and with leading and/or
 * trailing digits dropped (`support1`, `0support`). A digit can be either a
 * lookalike (`9uap`) or decoration, so both readings are checked.
 */
function candidateSkeletons(name: string): string[] {
  const compact = name.toLowerCase().replace(/[._-]/g, '')
  const variants = [
    compact,
    compact.replace(/\d+$/, ''),
    compact.replace(/^\d+/, ''),
    compact.replace(/^\d+|\d+$/g, ''),
  ].filter((variant) => variant.length > 0)
  return [...new Set(variants.map(usernameSkeleton))]
}

const logger = new Logger('ReservedUsernames')
const USERNAME_SHAPE = /^[a-z0-9._-]{1,30}$/

const PROTECTED_SKELETONS = new Set(
  DEFAULT_RESERVED_USERNAMES.map(usernameSkeleton),
)
const FILLER_SKELETONS = new Set(FILLERS.map(usernameSkeleton))

/** Parsed RESERVED_USERNAMES values, keyed by the raw string (parsed once). */
const extraCache = new Map<string, ReadonlySet<string>>()

function extraSkeletons(raw: string | undefined): ReadonlySet<string> {
  if (!raw) {
    return new Set()
  }
  const cached = extraCache.get(raw)
  if (cached) {
    return cached
  }
  const entries = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
  const invalid = entries.filter((entry) => !USERNAME_SHAPE.test(entry))
  const skeletons = new Set(
    entries
      .filter((entry) => USERNAME_SHAPE.test(entry))
      .map(usernameSkeleton)
      .filter((skeleton) => skeleton.length > 0),
  )
  if (invalid.length > 0 || skeletons.size < entries.length - invalid.length) {
    logger.warn({
      event: 'reserved_usernames.ignored_entries',
      ignored: entries.length - skeletons.size,
    })
  }
  extraCache.set(raw, skeletons)
  return skeletons
}

/**
 * True when `skeleton` splits entirely into protected words and fillers, with
 * at least one protected word: `guapsupportteam`, `theguap`, `adminhelp`.
 */
function segmentsIntoProtected(
  skeleton: string,
  protectedWords: ReadonlySet<string>,
): boolean {
  // state[i]: 0 = prefix not segmentable, 1 = only fillers, 2 = has protected
  const state = new Array<number>(skeleton.length + 1).fill(0)
  state[0] = 1
  for (let end = 1; end <= skeleton.length; end++) {
    for (let start = 0; start < end; start++) {
      if (state[start] === 0) {
        continue
      }
      // A word may also reuse the previous word's last character: collapsing
      // `support` + `team` leaves one `t` (`suporteam`).
      for (const from of start > 0 ? [start, start - 1] : [start]) {
        const word = skeleton.slice(from, end)
        if (protectedWords.has(word)) {
          state[end] = 2
        } else if (FILLER_SKELETONS.has(word) && state[end] < state[start]) {
          state[end] = state[start]
        }
      }
      if (state[end] === 2) {
        break
      }
    }
  }
  return state[skeleton.length] === 2
}

/**
 * True when `username` (already normalised) is a reserved name, a lookalike
 * of one, or a compound of reserved names and fillers. `extra` is the raw
 * `RESERVED_USERNAMES` config value.
 */
export function isReservedUsername(username: string, extra?: string): boolean {
  const additional = extraSkeletons(extra)
  const protectedWords =
    additional.size === 0
      ? PROTECTED_SKELETONS
      : new Set([...PROTECTED_SKELETONS, ...additional])
  return candidateSkeletons(username).some((skeleton) =>
    segmentsIntoProtected(skeleton, protectedWords),
  )
}
