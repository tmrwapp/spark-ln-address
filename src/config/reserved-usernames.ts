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

export const DEFAULT_RESERVED_USERNAMES: readonly string[] = Object.freeze([
  ...new Set([
    ...STANDALONE,
    ...BRANDS,
    ...BRANDS.flatMap((brand) =>
      [...ROLES, ...STANDALONE].flatMap((role) => [
        `${brand}${role}`,
        `${role}${brand}`,
      ]),
    ),
  ]),
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
}

/**
 * Collapses a username to a comparison key, so `Gu4p.Supp0rt`, `guap_suport`,
 * `support1` and `guapsupport` all share one:
 * 1. lowercase, separators `._-` removed;
 * 2. trailing digits removed (`support1`), unless the name is all digits;
 * 3. multi-letter lookalikes folded (`rn` to `m`, `vv` to `w`);
 * 4. digit and letter lookalikes folded (`0` to `o`, `1` and `l` to `i`, ...);
 * 5. repeated characters collapsed (`suppport`, `guapp`).
 * Unicode homoglyphs cannot occur: normalizeUsername allows `[a-z0-9._-]` only.
 */
export function usernameSkeleton(name: string): string {
  const compact = name.toLowerCase().replace(/[._-]/g, '')
  const trimmed = compact.replace(/\d+$/, '') || compact
  return trimmed
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/[0-9l]/g, (c) => LOOKALIKES[c] ?? c)
    .replace(/(.)\1+/g, '$1')
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
