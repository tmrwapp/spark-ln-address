import { Logger } from '@nestjs/common'
import { verifySignature } from './secp256k1.utils'

/** Every string written to the logger, including strings nested in objects. */
function loggedStrings(spies: jest.SpyInstance[]): string[] {
  const out: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  spies.forEach((spy) => spy.mock.calls.forEach((call) => call.forEach(walk)))
  return out
}

describe('secp256k1.utils logging (issue 34)', () => {
  let spies: jest.SpyInstance[]

  beforeEach(() => {
    spies = (['log', 'warn', 'error'] as const).map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    )
  })

  afterEach(() => jest.restoreAllMocks())

  it('does not echo a non-hex signature carrying a forged log line', async () => {
    const sig = 'zz\n[Nest] LOG forged' + 'q'.repeat(5_000)
    await expect(
      verifySignature('a'.repeat(64), sig, '02'.padEnd(66, '1')),
    ).resolves.toBe(false)

    const text = loggedStrings(spies).join('|')
    expect(text).not.toMatch(/[\r\n]/)
    expect(text).not.toContain('forged')
    expect(text.length).toBeLessThan(400)
  })

  it('never logs a full signature', async () => {
    const sig = 'ab'.repeat(36) // valid hex, wrong signature
    await verifySignature('a'.repeat(64), sig, 'x'.repeat(66))

    const text = loggedStrings(spies).join('|')
    expect(text).not.toContain(sig)
  })

  it('logs a malformed key escaped and truncated', async () => {
    const key = 'k\r\nINJECTED' + 'k'.repeat(5_000)
    await verifySignature('a'.repeat(64), 'ab'.repeat(32), key)

    const text = loggedStrings(spies).join('|')
    expect(text).not.toMatch(/[\r\n]/)
    expect(text.length).toBeLessThan(400)
  })

  it('logs a malformed message escaped and truncated', async () => {
    const message = 'm\nINJECTED' + 'm'.repeat(5_000)
    await verifySignature(message, 'ab'.repeat(32), '02'.padEnd(66, '1'))

    const text = loggedStrings(spies).join('|')
    expect(text).not.toMatch(/[\r\n]/)
    expect(text.length).toBeLessThan(400)
  })
})
