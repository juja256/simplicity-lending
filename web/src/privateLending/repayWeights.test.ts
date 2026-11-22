import { describe, expect, it } from 'vitest'

import { estimateFeeBudgetSats, WALLET_OVERHEAD_WEIGHT_UNITS } from '@/lwk/utxo'

import {
  CONFIDENTIAL_OUTPUT_WEIGHT_UNITS,
  INSTALLMENT_WEIGHT_UNITS,
  MEASURED_FIRST_INSTALLMENT_WEIGHT_UNITS,
  MEASURED_FULL_REPAYMENT_WEIGHT_UNITS,
  MEASURED_TESTNET_FIRST_INSTALLMENT_WEIGHT_UNITS,
  REPAY_WEIGHT_UNITS,
} from './repayWeights'

// The measured weights the reserves must cover before their 15 % margin:
// - 49,319 WU: the first installment on regtest (phase 7 task 5's weight test, 5 inputs, 10
//   outputs); 45,535 WU a later one there and on testnet;
// - 49,867 WU: the testnet e2e's first installment (phase 7 task 10, 8a15aa32…6f1bca, 7 inputs);
// - 30,064 WU: the testnet e2e's full repayment (phase 7 task 10, 934cf610…a2e2, 6 inputs, 7
//   outputs), with the collateral released and both carries burned;
// - 4,845 WU: the heaviest confidential output in those two testnet transactions.
const MEASURED_INSTALLMENTS = [49_319, 45_535, 49_867]
const MEASURED_FULL_REPAYMENT = 30_064
const MEASURED_CONFIDENTIAL_OUTPUT = 4_845

describe('the fee reserve of a payment', () => {
  it('names the measured figures', () => {
    expect(MEASURED_FIRST_INSTALLMENT_WEIGHT_UNITS).toBe(49_319)
    expect(MEASURED_TESTNET_FIRST_INSTALLMENT_WEIGHT_UNITS).toBe(49_867)
    expect(MEASURED_FULL_REPAYMENT_WEIGHT_UNITS).toBe(MEASURED_FULL_REPAYMENT)
  })

  it('counts a confidential output at no less than the heaviest measured', () => {
    expect(CONFIDENTIAL_OUTPUT_WEIGHT_UNITS).toBeGreaterThanOrEqual(MEASURED_CONFIDENTIAL_OUTPUT)
  })

  it('covers every measured installment before the margin, even without the overhead', () => {
    for (const measured of MEASURED_INSTALLMENTS) {
      expect(INSTALLMENT_WEIGHT_UNITS).toBeGreaterThanOrEqual(measured)
    }
  })

  it('covers the measured full repayment before the margin, with the wallet overhead', () => {
    expect(REPAY_WEIGHT_UNITS + WALLET_OVERHEAD_WEIGHT_UNITS).toBeGreaterThanOrEqual(
      MEASURED_FULL_REPAYMENT,
    )
    expect(REPAY_WEIGHT_UNITS).toBeGreaterThanOrEqual(4 * CONFIDENTIAL_OUTPUT_WEIGHT_UNITS)
  })

  it('reserves at least the fee of each measured payment, by weight, at 100 sat/kvb', () => {
    const feeOf = (weight: number) => BigInt(Math.ceil((Math.ceil(weight / 4) * 100) / 1000))
    for (const measured of MEASURED_INSTALLMENTS) {
      expect(estimateFeeBudgetSats(INSTALLMENT_WEIGHT_UNITS, 100)).toBeGreaterThanOrEqual(
        feeOf(measured),
      )
    }
    expect(estimateFeeBudgetSats(REPAY_WEIGHT_UNITS, 100)).toBeGreaterThanOrEqual(
      feeOf(MEASURED_FULL_REPAYMENT),
    )
  })

  it('budgets the installment and the margin, besides the wallet overhead', () => {
    const budget = Number(estimateFeeBudgetSats(INSTALLMENT_WEIGHT_UNITS, 1000))
    expect(budget).toBeGreaterThanOrEqual(
      Math.ceil((49_867 / 4) * 1.15) + WALLET_OVERHEAD_WEIGHT_UNITS / 4,
    )
  })
})
