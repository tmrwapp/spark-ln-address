import { describeSecret, errorForLog, sanitizeForLog } from './log-sanitize'

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
