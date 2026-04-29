import { Prisma } from '@prisma/client'

/**
 * Converts a USDB amount expressed in smallest units (6 decimal places, as
 * returned by the Flashnet API) to a human-readable Decimal value suitable for
 * storage in our Decimal(38,8) columns.
 *
 * Examples:
 *   "1"       → 0.000001  USDB
 *   "920000"  → 0.92      USDB
 *   "1234567" → 1.234567  USDB
 *
 * Persisting the raw string without conversion would over-credit users by a
 * factor of 1,000,000.
 */
export function usdbSmallestUnitsToDecimal(smallestUnits: string): Prisma.Decimal {
  const raw = new Prisma.Decimal(smallestUnits)
  return raw.div(new Prisma.Decimal('1000000'))
}
