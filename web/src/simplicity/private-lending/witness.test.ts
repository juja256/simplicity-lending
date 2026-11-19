import '@/test/lwk'

import { describe, expect, it } from 'vitest'

import {
  buildPrivateLendingWitness,
  privateLendingPath,
  type PrivateLendingWitness,
} from './witness'

const X = 'c3'.repeat(32)
const KEY = '5e'.repeat(32)

// No parity vector covers these two branches: the bit is the low bit of the commitment's prefix,
// true for 09 (y not a square) and false for 08.
describe('the private lending witness', () => {
  it("gives the installment the debt's prefix bit and x", () => {
    expect(privateLendingPath({ branch: 'Installment', debt: `08${X}` })).toBe(
      `Right(Left(Left((false, 0x${X}))))`,
    )
    expect(privateLendingPath({ branch: 'Installment', debt: `09${X}` })).toBe(
      `Right(Left(Left((true, 0x${X}))))`,
    )
  })

  it('gives the zero-debt close the debt and the key', () => {
    expect(privateLendingPath({ branch: 'ZeroDebtClose', debt: `08${X}`, key: KEY })).toBe(
      `Right(Left(Right(Right(((false, 0x${X}), 0x${KEY})))))`,
    )
    expect(privateLendingPath({ branch: 'ZeroDebtClose', debt: `09${X}`, key: KEY })).toBe(
      `Right(Left(Right(Right(((true, 0x${X}), 0x${KEY})))))`,
    )
  })

  it('parses both branches with either bit against the path type', () => {
    const witnesses: PrivateLendingWitness[] = ['08', '09'].flatMap(prefix => [
      { branch: 'Installment', debt: `${prefix}${X}` },
      { branch: 'ZeroDebtClose', debt: `${prefix}${X}`, key: KEY },
    ])
    for (const witness of witnesses) {
      expect(() => buildPrivateLendingWitness(witness)).not.toThrow()
    }
  })

  it('refuses a debt that is not a confidential value commitment', () => {
    for (const debt of [`0a${X}`, `01${'00'.repeat(8)}`, X, `08${X}00`]) {
      expect(() => privateLendingPath({ branch: 'Installment', debt })).toThrow(
        'The debt must be a value commitment',
      )
      expect(() => privateLendingPath({ branch: 'ZeroDebtClose', debt, key: KEY })).toThrow(
        'The debt must be a value commitment',
      )
    }
    expect(() =>
      privateLendingPath({ branch: 'ZeroDebtClose', debt: `08${X}`, key: KEY.slice(2) }),
    ).toThrow('The zero-debt key must be 32 bytes of hex')
  })
})
