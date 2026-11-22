import '@/test/lwk'

import { describe, expect, it } from 'vitest'

import {
  buildPrivateLendingWitness,
  type InstallmentWitness,
  privateLendingPath,
  type PrivateLendingWitness,
} from './witness'

const X = 'c3'.repeat(32)
const HASH = '5e'.repeat(32)
const POINT = `${'a1'.repeat(32)}${'b2'.repeat(32)}`

function installment(debt: string, overrides: Partial<InstallmentWitness> = {}) {
  return {
    branch: 'Installment' as const,
    debt,
    index: 5,
    blinderCommitment: POINT,
    path: Array.from({ length: 10 }, (_, k) => ({ isRight: k % 2 === 1, sibling: HASH })),
    commitments: Array(7).fill(POINT),
    responses: Array(11).fill(HASH),
    ...overrides,
  }
}

// The parity script checks these branches' witness bytes against the contracts' Rust
// (`checkWitnessVectors`), with a debt of each prefix bit across the two offers. These check the
// path for either bit: the bit is the low bit of the commitment's prefix, true for 09 (y not a
// square) and false for 08.
describe('the private lending witness', () => {
  it("gives the installment the debt's prefix bit and x, the index, Y, its path, the proof", () => {
    const point = `(0x${'a1'.repeat(32)}, 0x${'b2'.repeat(32)})`
    const path = Array.from({ length: 10 }, (_, k) => `(${k % 2 === 1}, 0x${HASH})`).join(', ')
    const ts = Array(7).fill(point).join(', ')
    const proof = `(${ts}), (${Array(11).fill(`0x${HASH}`).join(', ')})`
    for (const [prefix, bit] of [
      ['08', false],
      ['09', true],
    ] as const) {
      expect(privateLendingPath(installment(`${prefix}${X}`))).toBe(
        `Right(Left(Left(((${bit}, 0x${X}), 5, ${point}, [${path}], ${proof}))))`,
      )
    }
  })

  it('gives the full repayment the debt hash', () => {
    expect(privateLendingPath({ branch: 'FullRepayment', debtHash: HASH })).toBe(
      `Right(Left(Right(0x${HASH})))`,
    )
  })

  it('parses every branch with either bit against the path type', () => {
    const witnesses: PrivateLendingWitness[] = [
      { branch: 'OfferAcceptance' },
      { branch: 'OfferCancellation' },
      installment(`08${X}`),
      installment(`09${X}`, { index: 1023 }),
      { branch: 'FullRepayment', debtHash: HASH },
      { branch: 'Liquidation', debtHash: HASH, salt: HASH, expiry: 163 },
    ]
    for (const witness of witnesses) {
      expect(() => buildPrivateLendingWitness(witness)).not.toThrow()
    }
  })

  it('refuses an installment the program cannot take', () => {
    for (const debt of [`0a${X}`, `01${'00'.repeat(8)}`, X, `08${X}00`]) {
      expect(() => privateLendingPath(installment(debt))).toThrow(
        'The debt must be a value commitment',
      )
    }
    const debt = `08${X}`
    for (const index of [-1, 1024, 1.5]) {
      expect(() => privateLendingPath(installment(debt, { index }))).toThrow(
        'The index must be an integer from 0 to 1023',
      )
    }
    const path = installment(debt).path
    expect(() => privateLendingPath(installment(debt, { path: path.slice(1) }))).toThrow(
      'The path must have 10 nodes',
    )
    expect(() =>
      privateLendingPath(installment(debt, { commitments: Array(6).fill(POINT) })),
    ).toThrow('The proof must have 7 commitments')
    expect(() =>
      privateLendingPath(installment(debt, { responses: Array(12).fill(HASH) })),
    ).toThrow('The proof must have 11 responses')
    expect(() =>
      privateLendingPath(installment(debt, { blinderCommitment: POINT.slice(2) })),
    ).toThrow('The blinder commitment must be 64 bytes of hex')
    expect(() =>
      privateLendingPath(
        installment(debt, { path: path.map(node => ({ ...node, sibling: X.slice(2) })) }),
      ),
    ).toThrow('The path sibling must be 32 bytes of hex')
  })
})
