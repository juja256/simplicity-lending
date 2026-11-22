import { describe, expect, it } from 'vitest'

import {
  estimateFeeBudgetSats,
  WALLET_OVERHEAD_WEIGHT_UNITS,
  weightUnitsToSats,
} from '@/lwk/weights'

import {
  ACCEPT_WEIGHT_UNITS,
  CANCEL_WEIGHT_UNITS,
  CLAIM_PRINCIPAL_WEIGHT_UNITS,
  finalClaimWeightUnits,
  installmentClaimWeightUnits,
  liquidationWeightUnits,
} from './actionWeights'

// The fee rate the testnet e2e built at (`scripts/e2e/wallet.ts`, `feeRate: 100`), in sat/kvb.
const FEE_RATE = 100

// The fees the testnet e2e's transactions paid at that rate (phase 7 task 10, from esplora; the
// whole weights for comparison, which these reserves do not stand for: the fee is charged on the
// discounted size):
// - acceptance 1202f9c8…62c7: 177 sats (24,812 WU);
// - cancellation 27e2c798…7583: 171 sats (15,403 WU), the carry supply burned;
// - liquidation 8f72e00b…d08b, sweeping no installment: 121 sats (13,548 WU);
// - the `create` loan's dry liquidation, sweeping one installment (liquidate-dry, finalized, not
//   broadcast): 152 sats;
// - principal claim 26cee64d…3a7e: 65 sats (11,510 WU);
// - installment claim 589f475b…d7fc, one installment: 65 sats (11,505 WU);
// - final claim 4f98d106…3e58, the repayment and one installment: 90 sats (12,415 WU).
const MEASURED: [action: string, units: number, fee: bigint][] = [
  ['acceptance', ACCEPT_WEIGHT_UNITS, 177n],
  ['cancellation', CANCEL_WEIGHT_UNITS, 171n],
  ['liquidation', liquidationWeightUnits(0), 121n],
  ['liquidation sweeping an installment', liquidationWeightUnits(1), 152n],
  ['principal claim', CLAIM_PRINCIPAL_WEIGHT_UNITS, 65n],
  ['installment claim', installmentClaimWeightUnits(1), 65n],
  ['final claim', finalClaimWeightUnits(true, 1), 90n],
]

describe('the fee reserve of the other private actions, which budgets the discounted size', () => {
  it.each(MEASURED)('covers the measured fee of the %s before the margin', (_, units, fee) => {
    expect(
      weightUnitsToSats(units + WALLET_OVERHEAD_WEIGHT_UNITS, FEE_RATE),
    ).toBeGreaterThanOrEqual(fee)
  })

  it.each(MEASURED)(
    'reserves, with the margin, at least the measured fee of the %s',
    (_, units, fee) => {
      expect(estimateFeeBudgetSats(units, FEE_RATE)).toBeGreaterThanOrEqual(fee)
    },
  )

  it('counts each swept installment and the repayment', () => {
    expect(liquidationWeightUnits(2) - liquidationWeightUnits(1)).toBeGreaterThan(0)
    expect(installmentClaimWeightUnits(2) - installmentClaimWeightUnits(1)).toBeGreaterThan(0)
    expect(finalClaimWeightUnits(true, 0)).toBeGreaterThan(finalClaimWeightUnits(false, 0))
  })
})
