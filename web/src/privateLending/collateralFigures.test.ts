import { describe, expect, it } from 'vitest'

import { collateralLeft, releaseForPayment } from './collateralFigures'

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

/** A loan of collateral `total` and repayment `repayment` that still owes `owed`. */
function loanOf(total: bigint, repayment: bigint, owed: bigint) {
  return { total, repayment, owed, held: ceilDiv(owed * total, repayment) }
}

describe('releaseForPayment', () => {
  it('releases c_k − ceil((d_k − p)·C/R) for an installment', () => {
    // C = 1,000, R = 3,000: every 3 owed hold 1 of collateral
    const loan = loanOf(1_000n, 3_000n, 3_000n)
    expect(releaseForPayment(loan, 1_500n)).toBe(500n)
    // paying 1 of 3,000 releases nothing: ceil(2,999 / 3) = 1,000
    expect(releaseForPayment(loan, 1n)).toBe(0n)
    // 4 of 3,000: ceil(2,996 / 3) = 999
    expect(releaseForPayment(loan, 4n)).toBe(1n)
  })

  it('releases all the collateral held for the full repayment', () => {
    const loan = loanOf(1_000n, 3_000n, 2_000n)
    expect(loan.held).toBe(667n)
    expect(releaseForPayment(loan, 2_000n)).toBe(667n)
  })

  it('adds up to the collateral over a loan of any installments: the edges e = 0, e = R − 1', () => {
    // e_k = 0 at the start (held·R = C·R), and R − 1 where the ceiling rounds the most
    for (const [total, repayment] of [
      [1n, 2n],
      [7n, 11n],
      [1_000n, 3_000n],
      [1n << 44n, (1n << 50n) - 2n],
    ] as const) {
      let owed = repayment
      let released = 0n
      for (const payment of [1n, repayment / 3n, 1n, repayment / 5n]) {
        if (payment < 1n || payment >= owed) continue
        const release = releaseForPayment(loanOf(total, repayment, owed), payment)
        expect(release).toBeDefined()
        released += release ?? 0n
        owed -= payment
      }
      const last = releaseForPayment(loanOf(total, repayment, owed), owed)
      expect((last ?? 0n) + released).toBe(total)
    }
  })

  it('leaves the figure out when it does not fit the release rule', () => {
    const loan = loanOf(1_000n, 3_000n, 3_000n)
    expect(releaseForPayment(loan, 0n)).toBeUndefined()
    expect(releaseForPayment({ ...loan, held: loan.held - 1n }, 1_000n)).toBeUndefined()
    expect(releaseForPayment({ ...loan, held: 0n }, 1_000n)).toBeUndefined()
    expect(releaseForPayment({ ...loan, repayment: 0n }, 1_000n)).toBeUndefined()
  })
})

describe('collateralLeft', () => {
  const idle = { status: 'idle' } as const

  it('is unread until the loan is', () => {
    expect(collateralLeft(100n, undefined, idle)).toEqual({ kind: 'unread' })
  })

  it('gives what was released and what is left from the loan, with no search', () => {
    expect(collateralLeft(100n, { collateral: 60n }, idle)).toEqual({
      kind: 'known',
      left: 60n,
      released: 40n,
    })
    expect(collateralLeft(100n, { collateral: 100n }, idle)).toEqual({
      kind: 'known',
      left: 100n,
      released: 0n,
    })
  })

  it('says computing while the lender searches, then gives the answer', () => {
    expect(collateralLeft(100n, {}, { status: 'pending' })).toEqual({ kind: 'computing' })
    expect(collateralLeft(100n, {}, { status: 'success', amount: 25n })).toEqual({
      kind: 'known',
      left: 25n,
      released: 75n,
    })
  })

  it('is unknown for a search that found nothing, failed, was not run, or found nonsense', () => {
    expect(collateralLeft(100n, {}, { status: 'success', amount: undefined })).toEqual({
      kind: 'unknown',
    })
    expect(collateralLeft(100n, {}, { status: 'error' })).toEqual({ kind: 'unknown' })
    expect(collateralLeft(100n, {}, idle)).toEqual({ kind: 'unknown' })
    expect(collateralLeft(100n, {}, { status: 'success', amount: 101n })).toEqual({
      kind: 'unknown',
    })
    expect(collateralLeft(100n, { collateral: 0n }, idle)).toEqual({ kind: 'unknown' })
  })
})
