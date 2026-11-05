import {
  describeSecret,
  errorForLog,
  logLine,
  sanitizeForLog,
} from './log-sanitize'

describe('log sanitising (issue 34)', () => {
  it('escapes CR/LF so a value cannot forge a second log line', () => {
    const out = sanitizeForLog(
      'bob\n[Nest] 1 - LOG [AuthService] admin verified',
      200,
    )
    expect(out).not.toMatch(/[\r\n]/)
    expect(out).toContain('\\u000a')
  })

  it('escapes other control characters, including ANSI escapes and U+2028', () => {
    const out = sanitizeForLog('a\u001b[31mred\u0000\u2028b', 200)
    expect(out).not.toMatch(/[\u0000-\u001f\u007f\u2028\u2029]/)
  })

  it('truncates long values and records the original length', () => {
    const out = sanitizeForLog('x'.repeat(10_000))
    expect(out.length).toBeLessThan(80)
    expect(out).toContain('10000 chars')
  })

  it('escapes a literal backslash so it cannot imitate an escape', () => {
    expect(sanitizeForLog('a\\u000ab', 200)).toBe('a\\\\u000ab')
  })

  it('never splits an escape sequence when truncating', () => {
    const out = sanitizeForLog('\n'.repeat(40), 5)
    expect(out).toBe('\\u000a'.repeat(5) + '...[40 chars]')
  })

  it.each([
    ['C1 NEL', '\u0085'],
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
    ['right-to-left override', '\u202e'],
    ['zero-width space', '\u200b'],
    ['byte order mark', '\ufeff'],
    ['isolate', '\u2066'],
  ])('escapes the %s character', (_name, char) => {
    const out = sanitizeForLog(`a${char}b`, 200)
    expect(out).not.toContain(char)
    expect(out).toMatch(/^a\\u[0-9a-f]{4}b$/)
  })

  it('keeps exactly 32 characters, and notes the length from 33 on', () => {
    expect(sanitizeForLog('x'.repeat(32))).toBe('x'.repeat(32))
    expect(sanitizeForLog('x'.repeat(33))).toBe(
      'x'.repeat(32) + '...[33 chars]',
    )
  })

  it('never leaves half of a surrogate pair at the cut', () => {
    const out = sanitizeForLog('x'.repeat(31) + '\ud83d\ude00' + 'y')
    expect(out.startsWith('x'.repeat(31) + '\ud83d\ude00')).toBe(true)
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })

  it('keeps a whole uncompressed public key when given its limit', () => {
    const key = '04' + 'ab'.repeat(64)
    expect(sanitizeForLog(key, 130)).toBe(key)
  })

  it('renders one structured event as a single line', () => {
    const line = logLine({ event: 'x', value: sanitizeForLog('a\nb', 200) })
    expect(line).not.toMatch(/[\r\n]/)
    expect(JSON.parse(line)).toEqual({ event: 'x', value: 'a\\u000ab' })
  })

  it('keeps the error name', () => {
    expect(errorForLog(new TypeError('bad'))).toBe('TypeError: bad')
  })

  it('leaves short printable values untouched', () => {
    expect(sanitizeForLog('alice')).toBe('alice')
  })

  it('stringifies non-string values', () => {
    expect(sanitizeForLog(42)).toBe('42')
    expect(sanitizeForLog(undefined)).toBe('undefined')
  })

  it('describes a secret by length only, never its content', () => {
    const sig = 'ab'.repeat(64)
    const out = describeSecret(sig)
    expect(out).toEqual({ length: 128 })
    expect(JSON.stringify(out)).not.toContain('abab')
  })

  it('reduces an error to a bounded, escaped message', () => {
    const out = errorForLog(new Error('boom\n' + 'y'.repeat(5_000)))
    expect(out).not.toMatch(/\n/)
    expect(out.length).toBeLessThan(260)
    expect(errorForLog('plain')).toBe('plain')
  })
})
