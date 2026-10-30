// Coin selection for the private builders, which take the wallet's coins with their secrets
// (`WalletTxOut`). The public selection rules apply (confirmed coins, largest first, the fee
// reserve), and the picked coins keep their type.
import type { WalletTxOut } from '@lilbonekit/lwk-web'

import { FALLBACK_FEE_RATE_SAT_PER_KVB } from '@/api/esplora/fee'
import { estimateFeeBudgetSats, selectAssetUtxos, selectFeeUtxos } from '@/lwk/utxo'

/** Confirmed coins of `asset` covering `amount`. Throws on an insufficient balance. */
export function selectAssetCoins(
  coins: WalletTxOut[],
  asset: string,
  amount: bigint,
  label: string,
): WalletTxOut[] {
  const picked = selectAssetUtxos(coins, asset, amount, label)
  return coins.filter(coin => picked.includes(coin))
}

/**
 * Confirmed policy-asset coins covering the fee of a transaction whose covenant inputs weigh
 * `weightUnits`, at `feeRate` (sat/kvb, or the fallback rate). Coins in `exclude` are left out, so
 * every input of the transaction stays distinct. Throws on an insufficient balance.
 */
export function selectFeeCoins(
  coins: WalletTxOut[],
  policyAsset: string,
  weightUnits: number,
  feeRate: number | null,
  exclude: readonly WalletTxOut[] = [],
): WalletTxOut[] {
  const rate = feeRate ?? FALLBACK_FEE_RATE_SAT_PER_KVB
  const candidates = coins.filter(coin => !exclude.includes(coin))
  const picked = selectFeeUtxos(
    candidates,
    policyAsset,
    estimateFeeBudgetSats(weightUnits, rate),
    rate,
  )
  return candidates.filter(coin => picked.includes(coin))
}
