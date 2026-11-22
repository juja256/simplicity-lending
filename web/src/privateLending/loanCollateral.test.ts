// The collateral figures of a loan read on the parity fixture's chain: what `loanFigures` reads of
// it, and the form's release preview against the wasm's own `releasePreview`.
import { describe, expect, it } from 'vitest'

import {
  acceptanceTxid,
  fakeChain,
  fixture,
  installmentTxid,
  keys,
  openOffer,
} from '@/test/privateChain'

import { collateralLeft, releaseForPayment } from './collateralFigures'
import { loanFigures } from './hooks/useLoan'
import { loadLoan } from './loan'

describe('the collateral of a loan read on chain', () => {
  it('previews the release the wasm builds, at acceptance and after an installment', async () => {
    const offer = await openOffer('borrower')
    const total = offer.opened.collateralAmount()
    const repayment = offer.opened.repaymentAmount()
    for (const outpoint of [`${acceptanceTxid}:0`, `${installmentTxid}:1`]) {
      const loan = await loadLoan(fakeChain().deps, offer, keys.borrower, outpoint)
      const owed = loan.state.remaining
      const held = loan.state.collateral()?.amount
      expect(owed).toBeDefined()
      expect(held).toBeDefined()
      const input = { total, repayment, owed: owed ?? 0n, held: held ?? 0n }
      const amounts = [1n, 2n, 7n, 1_000n, (owed ?? 0n) / 2n, (owed ?? 0n) - 1n, owed ?? 0n]
      for (const amount of amounts.filter(amount => amount >= 1n && amount <= input.owed)) {
        expect(releaseForPayment(input, amount)).toBe(loan.state.releasePreview(amount))
      }
      loan.state.free()
    }
  })

  it('gives the collateral released and left, and no search for a loan the party reads', async () => {
    const offer = await openOffer('borrower')
    const total = offer.opened.collateralAmount()
    const atAcceptance = await loadLoan(
      fakeChain().deps,
      offer,
      keys.borrower,
      `${acceptanceTxid}:0`,
    )
    const figures = loanFigures(atAcceptance)
    atAcceptance.state.free()
    expect(figures.collateral).toBe(total)
    expect(figures.collateralSearch).toBeUndefined()
    expect(collateralLeft(total, figures, { status: 'idle' })).toEqual({
      kind: 'known',
      left: total,
      released: 0n,
    })

    const afterOne = await loadLoan(fakeChain().deps, offer, keys.borrower, `${installmentTxid}:1`)
    const later = loanFigures(afterOne)
    afterOne.state.free()
    expect(later.collateral).toBeLessThanOrEqual(total)
    expect(collateralLeft(total, later, { status: 'idle' })).toMatchObject({
      kind: 'known',
      left: later.collateral,
      released: total - (later.collateral ?? 0n),
    })
    expect(fixture.loan.installment_txs).toHaveLength(1)
  })

  it('hands the lender the search for a collateral it cannot compute, with plain values', async () => {
    const offer = await openOffer('lender')
    const loan = await loadLoan(fakeChain().deps, offer, keys.lender, `${installmentTxid}:1`)
    const hidden = new Proxy(loan.state, {
      get(target, property) {
        if (property === 'collateral') return () => undefined
        const value: unknown = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const figures = loanFigures({ ...loan, state: hidden })
    loan.state.free()
    expect(figures.collateral).toBeUndefined()
    expect(figures.collateralSearch).toMatchObject({
      max: offer.opened.collateralAmount(),
      valueCommitment: expect.stringMatching(/^[0-9a-f]{66}$/) as unknown,
      assetCommitment: expect.stringMatching(/^[0-9a-f]{66}$/) as unknown,
      blinder: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    })
    // computing while it runs
    expect(collateralLeft(offer.opened.collateralAmount(), figures, { status: 'pending' })).toEqual(
      { kind: 'computing' },
    )
  })
})
