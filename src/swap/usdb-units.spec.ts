import { Prisma } from '@prisma/client'
import { usdbSmallestUnitsToDecimal } from './usdb-units'

describe('usdbSmallestUnitsToDecimal', () => {
  it('converts "1" (1 smallest unit) to 0.000001 USDB', () => {
    const result = usdbSmallestUnitsToDecimal('1')
    expect(result.equals(new Prisma.Decimal('0.000001'))).toBe(true)
  })

  it('converts "920000" to 0.92 USDB', () => {
    const result = usdbSmallestUnitsToDecimal('920000')
    expect(result.equals(new Prisma.Decimal('0.92'))).toBe(true)
  })

  it('converts "1234567" to 1.234567 USDB', () => {
    const result = usdbSmallestUnitsToDecimal('1234567')
    expect(result.equals(new Prisma.Decimal('1.234567'))).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // PR5 additions — extended edge cases
  // ---------------------------------------------------------------------------

  it('converts "0" to 0 USDB', () => {
    const result = usdbSmallestUnitsToDecimal('0')
    expect(result.equals(new Prisma.Decimal('0'))).toBe(true)
  })

  it('converts "1000000" (1 USDB) to 1.000000', () => {
    const result = usdbSmallestUnitsToDecimal('1000000')
    expect(result.equals(new Prisma.Decimal('1'))).toBe(true)
  })

  it('converts very large value "100000000000000" ($100M USDB) without precision loss', () => {
    // 100,000,000 USDB = 100_000_000 * 1_000_000 smallest units
    const result = usdbSmallestUnitsToDecimal('100000000000000')
    expect(result.equals(new Prisma.Decimal('100000000'))).toBe(true)
  })

  it('returns a Prisma.Decimal instance', () => {
    const result = usdbSmallestUnitsToDecimal('500000')
    expect(result).toBeInstanceOf(Prisma.Decimal)
  })
})
