import { Logger } from '@nestjs/common'
import {
  BRANDS,
  DEFAULT_RESERVED_USERNAMES,
  FILLERS,
  ROLES,
  STANDALONE,
  isReservedUsername,
  usernameSkeleton,
} from './reserved-usernames'

describe('reserved usernames (issue 32)', () => {
  // One case per entry of every group, so a group that is defined but never
  // added to the reserved set fails here.
  describe.each([
    ['BRANDS', BRANDS],
    ['ROLES', ROLES],
    ['STANDALONE', STANDALONE],
  ])('every %s entry', (_group, names) => {
    it.each([...names])('reserves %s', (name) => {
      expect(isReservedUsername(name)).toBe(true)
    })
  })

  it.each(['pay', 'wallet', 'ops', 'hq', 'app', 'bot', 'care', 'news'])(
    'reserves the payments-domain role %s',
    (name) => {
      expect(isReservedUsername(name)).toBe(true)
    },
  )

  it('lists every group in DEFAULT_RESERVED_USERNAMES', () => {
    for (const name of [...BRANDS, ...ROLES, ...STANDALONE]) {
      expect(DEFAULT_RESERVED_USERNAMES).toContain(name)
    }
  })

  it.each([
    'supp0rt',
    'g.u.a.p',
    'gu4p',
    'adm1n',
    'guap_support',
    'guap-official',
    'help.desk',
    's3curity',
    'support1',
    '0support',
    '1admin',
    'admin2',
    'guap1',
    'suport',
    'guapp',
    'guaap',
    '9uap',
    '6uap',
    'quap',
    'tmrvv',
    'trnrw',
    'adrnin',
    'guapbilling',
    'refundguap',
    'theguap',
    'realsupport',
    'guapsupportteam',
    'supportteam',
    'supportbot',
    'admin-support',
    'adminhelp',
    'securityteam',
    'staffsupport',
    'mywallet',
  ])('rejects the lookalike or compound %s', (name) => {
    expect(isReservedUsername(name)).toBe(true)
  })

  // Pinned on purpose: whole-name matching keeps these ordinary names free.
  it.each([
    'alice',
    'bob',
    'bob2',
    'guapo',
    'satoshi',
    'helpful',
    'administrators1',
    'lily',
    'carlos',
    'ellie',
    'mall',
    'mali',
    'bing',
    'apple',
    'theo',
    'payne',
    'owner',
    'status',
    'spark',
    'lightning',
    'the',
    'my',
    'real',
    '2024',
  ])('allows the ordinary name %s', (name) => {
    expect(isReservedUsername(name)).toBe(false)
  })

  it('does not reserve filler words on their own', () => {
    for (const filler of FILLERS) {
      expect(isReservedUsername(filler)).toBe(false)
    }
  })

  it('extends the defaults with the RESERVED_USERNAMES config value', () => {
    expect(isReservedUsername('mateus')).toBe(false)
    expect(isReservedUsername('mateus', 'acme, mateus')).toBe(true)
    expect(isReservedUsername('m4teus', 'acme,mateus')).toBe(true)
    expect(isReservedUsername('mateussupport', 'acme,mateus')).toBe(true)
  })

  it('ignores blank, separator-only and invalid config entries, and warns once', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined)
    const raw = ' , ,-,foo bar,café,ok'
    expect(isReservedUsername('alice', raw)).toBe(false)
    expect(isReservedUsername('foobar', raw)).toBe(false)
    expect(isReservedUsername('ok', raw)).toBe(true)
    isReservedUsername('alice', raw)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('folds separators and digit lookalikes into one skeleton', () => {
    expect(usernameSkeleton('Gu4p.Supp0rt')).toBe(
      usernameSkeleton('guapsupport'),
    )
  })

  it('keeps every default entry a valid username', () => {
    for (const name of DEFAULT_RESERVED_USERNAMES) {
      expect(name).toMatch(/^[a-z0-9._-]{1,30}$/)
    }
  })
})
