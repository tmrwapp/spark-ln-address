import {
  DEFAULT_WEBHOOK_MAX_SKEW_MS,
  isFreshTimestamp,
} from './webhook-timestamp'

describe('isFreshTimestamp', () => {
  const now = 1_800_000_000_000 // ms
  const skew = DEFAULT_WEBHOOK_MAX_SKEW_MS

  it('accepts milliseconds within the window, both directions', () => {
    expect(isFreshTimestamp(String(now - skew), now, skew)).toBe(true)
    expect(isFreshTimestamp(String(now + skew), now, skew)).toBe(true)
  })

  it('rejects milliseconds just outside the window', () => {
    expect(isFreshTimestamp(String(now - skew - 1), now, skew)).toBe(false)
    expect(isFreshTimestamp(String(now + skew + 1), now, skew)).toBe(false)
  })

  it('reads values below 1e12 as seconds', () => {
    expect(isFreshTimestamp(String(now / 1000), now, skew)).toBe(true)
    expect(isFreshTimestamp(String(now / 1000 - 301), now, skew)).toBe(false)
  })

  it('treats exactly 1e12 as milliseconds (year 2001, stale)', () => {
    expect(isFreshTimestamp('1000000000000', now, skew)).toBe(false)
  })

  it('accepts leading zeros as the same number', () => {
    expect(isFreshTimestamp('0' + String(now), now, skew)).toBe(true)
  })

  it.each(['', '-1', '1.5', '1e12', ' 1', '0x10', '1'.repeat(17), '1, 2'])(
    'rejects the malformed value %p',
    (raw) => {
      expect(isFreshTimestamp(raw, now, skew)).toBe(false)
    },
  )
})
