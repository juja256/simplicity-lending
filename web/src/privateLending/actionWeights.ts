// What the private actions other than the borrower's payments weigh, for the fee reserve their
// modals ask the wallet's coins for (`selectFeeCoins`): the covenant and NFT inputs' witnesses, on
// top of which `estimateFeeBudgetSats` adds the wallet's overhead and a margin. The payments'
// weights are in `repayWeights.ts`.
//
// These budget the discounted size, not the whole weight. Elements charges the fee on the
// discounted vsize (`discountVsize`), which leaves out the confidential outputs' range and
// surjection proofs, about 4.3 kWU each; what is left is the inputs, their witnesses and the
// outputs' commitments and scripts, which the witnesses here and the wallet's 6,000 WU overhead
// cover. So the reserve covers the fee although the whole weight is two to three times what it
// stands for: on testnet the acceptance weighed 24,812 WU and paid a fee of 177 sats, against a
// reserve of 243 sats before the margin (`actionWeights.test.ts` pins each action's measured fee).
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import {
  ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY,
  ASSET_AUTH_MAX_WEIGHT_TO_SATISFY,
} from '@/simplicity/asset-auth/witness'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'
import { SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/script-auth/witness'

/**
 * The acceptance: the pending offer (OfferAcceptance) and the lender NFT at its script_auth lock.
 * It budgets the discounted size (above): the discount leaves out the proofs of its two
 * confidential outputs, the active offer and the principal.
 */
export const ACCEPT_WEIGHT_UNITS =
  PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.OfferAcceptance + SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY

/**
 * The cancellation: the pending offer (OfferCancellation), the lender NFT at its script_auth
 * lock, the borrower NFT, a wallet output, and the carry supply at its asset_auth. It budgets the
 * discounted size (above).
 */
export const CANCEL_WEIGHT_UNITS =
  PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.OfferCancellation +
  SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY +
  EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY +
  ASSET_AUTH_MAX_WEIGHT_TO_SATISFY

/**
 * The principal claim: the principal at its asset_auth (no burn), and the borrower NFT. It
 * budgets the discounted size (above).
 */
export const CLAIM_PRINCIPAL_WEIGHT_UNITS =
  ASSET_AUTH_MAX_WEIGHT_TO_SATISFY + EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY

/**
 * The liquidation: the active offer (Liquidation), the lender NFT, and each of the `installments`
 * it sweeps at its asset_auth (no burn). It budgets the discounted size (above).
 */
export function liquidationWeightUnits(installments: number): number {
  return (
    PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.Liquidation +
    EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY +
    installments * ASSET_AUTH_MAX_WEIGHT_TO_SATISFY
  )
}

/**
 * The lender's installment claim: the lender NFT, and each of `installments` at its asset_auth.
 * It budgets the discounted size (above).
 */
export function installmentClaimWeightUnits(installments: number): number {
  return EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY + installments * ASSET_AUTH_MAX_WEIGHT_TO_SATISFY
}

/**
 * The lender's final claim: the lender NFT, the repayment at its asset_auth (burn) when the loan
 * was repaid (`withRepayment`), and each of the `installments` it sweeps at its own. It budgets
 * the discounted size (above).
 */
export function finalClaimWeightUnits(withRepayment: boolean, installments: number): number {
  return (
    EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY +
    (withRepayment ? ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY : 0) +
    installments * ASSET_AUTH_MAX_WEIGHT_TO_SATISFY
  )
}
