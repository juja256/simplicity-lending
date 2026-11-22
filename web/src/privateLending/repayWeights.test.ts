import { describe, expect, it } from 'vitest'

import { estimateFeeBudgetSats, WALLET_OVERHEAD_WEIGHT_UNITS } from '@/lwk/utxo'

import {
  CONFIDENTIAL_OUTPUT_WEIGHT_UNITS,
  INSTALLMENT_WEIGHT_UNITS,
  MEASURED_FIRST_INSTALLMENT_WEIGHT_UNITS,
  REPAY_WEIGHT_UNITS,
} from './repayWeights'

describe('the fee reserve of a payment', () => {
  it('covers the whole first installment as measured, 49,319 WU', () => {
    expect(MEASURED_FIRST_INSTALLMENT_WEIGHT_UNITS).toBe(49_319)
    expect(INSTALLMENT_WEIGHT_UNITS).toBeGreaterThanOrEqual(MEASURED_FIRST_INSTALLMENT_WEIGHT_UNITS)
    // a feeRate of 100 sat/kvb: the reserve is at least the fee of the measured transaction
    const feeOfMeasured = BigInt(Math.ceil(49_319 / 4) * 100) / 1000n
    expect(estimateFeeBudgetSats(INSTALLMENT_WEIGHT_UNITS, 100)).toBeGreaterThan(feeOfMeasured)
  })

  it('budgets the measured transaction and the margin, besides the wallet overhead', () => {
    const budget = Number(estimateFeeBudgetSats(INSTALLMENT_WEIGHT_UNITS, 1000))
    expect(budget).toBeGreaterThanOrEqual(
      Math.ceil((49_319 / 4) * 1.15) + WALLET_OVERHEAD_WEIGHT_UNITS / 4,
    )
  })

  it('counts the full repayment’s four confidential outputs', () => {
    expect(REPAY_WEIGHT_UNITS).toBeGreaterThanOrEqual(4 * CONFIDENTIAL_OUTPUT_WEIGHT_UNITS)
  })
})
