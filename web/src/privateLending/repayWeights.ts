// What the borrower's payments weigh, for the fee reserve their form asks the wallet's coins for
// (`selectFeeCoins`). The weight is the covenant inputs' and the confidential outputs' beyond what
// `estimateFeeBudgetSats` adds for the wallet's own input, change output and the base transaction.
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { ASSET_AUTH_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/asset-auth/witness'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'

/**
 * What a confidential output weighs, its range proof (4,174 bytes) and surjection proof included:
 * at most 4,845 WU in the testnet e2e's installment and full repayment (phase 7 task 10), rounded
 * up. Its surjection proof grows with the transaction's inputs.
 */
export const CONFIDENTIAL_OUTPUT_WEIGHT_UNITS = 4_900

/** A loan has at most two carries: one before its first installment, two after. */
export const MAX_CARRIES = 2

/**
 * The whole first installment as the contracts measured it on regtest (task 5): 49,319 WU, with
 * its 5 inputs and 10 outputs; a later installment (two carries in) weighs 45,535 WU. The first is
 * the larger.
 */
export const MEASURED_FIRST_INSTALLMENT_WEIGHT_UNITS = 49_319

/**
 * The whole first installment of the testnet e2e (phase 7 task 10, 8a15aa32…6f1bca): 49,867 WU,
 * with 7 inputs (three principal coins) and 10 outputs. Its second installment weighed 45,535 WU.
 */
export const MEASURED_TESTNET_FIRST_INSTALLMENT_WEIGHT_UNITS = 49_867

/**
 * The whole full repayment of the testnet e2e (phase 7 task 10, 934cf610…a2e2), with the
 * collateral released and both carries burned: 30,064 WU, with 6 inputs (one principal coin, two
 * carries, one fee coin) and 7 outputs, the fewest a full repayment after an installment has.
 */
export const MEASURED_FULL_REPAYMENT_WEIGHT_UNITS = 30_064

/**
 * An installment's weight for the fee reserve: the larger whole installment measured, which already
 * counts every confidential output (the successor, the installment, the two carries, the release,
 * the leftover burn and the changes), so it covers a measured installment even without the
 * overhead. `estimateFeeBudgetSats` adds its overhead and a margin on top, so a wallet that is
 * short is told so before the build, not by the fee check after.
 */
export const INSTALLMENT_WEIGHT_UNITS = Math.max(
  MEASURED_FIRST_INSTALLMENT_WEIGHT_UNITS,
  MEASURED_TESTNET_FIRST_INSTALLMENT_WEIGHT_UNITS,
)

/**
 * The full repayment's weight beyond the wallet's overhead: the loan input's covenant, the borrower
 * NFT's signature, the carries' asset_auth, and the confidential outputs it adds: the repayment,
 * the collateral back, the carries' burn and the principal change. With the overhead it covers
 * the measured full repayment before the margin.
 */
export const REPAY_WEIGHT_UNITS =
  PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.FullRepayment +
  EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY +
  MAX_CARRIES * ASSET_AUTH_MAX_WEIGHT_TO_SATISFY +
  4 * CONFIDENTIAL_OUTPUT_WEIGHT_UNITS
