/**
 * Usernames nobody may register or change to (issue 32): brand, support and
 * role names that would let a stranger pose as the company, e.g. `support@`.
 *
 * Extend the list without a code change through the `RESERVED_USERNAMES`
 * config value (comma separated). The check runs on registration and on
 * claiming a new name; names already owned stay valid, see the callers.
 */

const BRANDS = ['guap', 'tmrw', 'tomorrow', 'guapwallet']

const ROLES = [
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

const STANDALONE = [
  'abuse',
  'account',
  'accounts',
  'admin',
  'administrator',
  'api',
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
  'lightning',
  'lnurl',
  'mail',
  'moderator',
  'no-reply',
  'noreply',
  'null',
  'official',
  'operator',
  'orchestra',
  'owner',
  'payments',
  'postmaster',
  'privacy',
  'refund',
  'refunds',
  'root',
  'security',
  'spark',
  'staff',
  'status',
  'superuser',
  'support',
  'sysadmin',
  'system',
  'team',
  'undefined',
  'verify',
  'verification',
  'webmaster',
  'www',
]

export const DEFAULT_RESERVED_USERNAMES: readonly string[] = Object.freeze([
  ...new Set([
    ...STANDALONE,
    ...BRANDS,
    ...BRANDS.flatMap((brand) =>
      ROLES.flatMap((role) => [`${brand}${role}`, `${role}${brand}`]),
    ),
  ]),
])

/** Digits and letters commonly swapped in to imitate another name. */
const LOOKALIKES: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  l: 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
}

/**
 * Collapses a username to a comparison key: lowercase, separators removed,
 * lookalike characters folded. `Gu4p.Supp0rt` and `guapsupport` share a key.
 */
export function usernameSkeleton(name: string): string {
  return name
    .toLowerCase()
    .replace(/[._-]/g, '')
    .replace(/[0134578l]/g, (c) => LOOKALIKES[c] ?? c)
}

const DEFAULT_SKELETONS = new Set(
  DEFAULT_RESERVED_USERNAMES.map(usernameSkeleton),
)

/**
 * True when `username` (already normalised) matches a reserved name or a
 * lookalike of one. `extra` is the raw `RESERVED_USERNAMES` config value.
 */
export function isReservedUsername(username: string, extra?: string): boolean {
  const skeleton = usernameSkeleton(username)
  if (DEFAULT_SKELETONS.has(skeleton)) {
    return true
  }
  if (!extra) {
    return false
  }
  return extra
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .some((entry) => usernameSkeleton(entry) === skeleton)
}
