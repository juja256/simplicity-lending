// Weights and the fee reserve free of app imports, so the DOM-free private flow builders and the
// Node e2e script can use them.

// ExternalUtxo max-weight-to-satisfy for an explicit-address UTXO spent with a plain
// p2wpkh/p2tr signature (no Simplicity covenant) — e.g. NFT references like FactoryAuth,
// Borrower NFT, or a pre-acceptance Lender NFT. Measured from several real broadcast txs
// (sig + pubkey = 104-105 bytes), plus margin.
export const EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY = 150

// Base overhead (WU) covering the wallet's first confidential input + change output + base tx,
// which `estimateFeeBudgetSats` adds to a transaction's own weight.
export const WALLET_OVERHEAD_WEIGHT_UNITS = 6000

// Additional wallet P2WPKH input delta measured from Liquid testnet create-offer txs:
// 1650 WU / 6 extra wallet inputs ≈ 275 WU, rounded up for margin.
export const FEE_WALLET_INPUT_WEIGHT_UNITS = 400
const FEE_SAFETY_MARGIN_PERCENT = 15n

export function weightUnitsToSats(weightUnits: number, feeRateSatPerKvb: number): bigint {
  const vsize = Math.ceil(weightUnits / 4)
  return BigInt(Math.ceil((vsize * feeRateSatPerKvb) / 1000))
}

// Sat ceiling for fee-UTXO selection, scaled by feeRate and expected wallet input count.
export function estimateFeeBudgetSats(
  externalWeightUnits: number,
  feeRateSatPerKvb: number,
  walletInputsCount = 1,
): bigint {
  const extraInputs = Math.max(walletInputsCount - 1, 0)
  const weightUnits =
    externalWeightUnits + WALLET_OVERHEAD_WEIGHT_UNITS + FEE_WALLET_INPUT_WEIGHT_UNITS * extraInputs
  const base = weightUnitsToSats(weightUnits, feeRateSatPerKvb)
  return base + (base * FEE_SAFETY_MARGIN_PERCENT) / 100n
}
