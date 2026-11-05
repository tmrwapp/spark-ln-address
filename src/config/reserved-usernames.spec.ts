import {
  DEFAULT_RESERVED_USERNAMES,
  isReservedUsername,
  usernameSkeleton,
} from './reserved-usernames'

describe('reserved usernames (issue 32)', () => {
  it.each(['admin', 'support', 'guap', 'help', 'security', 'root'])(
    'reserves %s by default',
    (name) => {
      expect(isReservedUsername(name)).toBe(true)
    },
  )

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
    'suport',
    'guapp',
    '9uap',
    'tmrvv',
    'guapbilling',
    'refundguap',
    'adrnin',
  ])('rejects the lookalike %s', (name) => {
    expect(isReservedUsername(name)).toBe(true)
  })

  it.each([
    'alice',
    'bob',
    'guapo',
    'satoshi',
    'helpful',
    'administrators1',
    'lily',
    'carlos',
    'ellie',
    'bob2',
    'owner',
    'status',
    'spark',
    'lightning',
  ])('allows the ordinary name %s', (name) => {
    expect(isReservedUsername(name)).toBe(false)
  })

  it('extends the defaults with the RESERVED_USERNAMES config value', () => {
    expect(isReservedUsername('mateus')).toBe(false)
    expect(isReservedUsername('mateus', 'ceo, mateus')).toBe(true)
    expect(isReservedUsername('m4teus', 'ceo,mateus')).toBe(true)
  })

  it('ignores blank entries in the config value', () => {
    expect(isReservedUsername('alice', ' , ,')).toBe(false)
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
