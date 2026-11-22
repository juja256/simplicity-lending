import type { AssetId } from 'lwk_wasm'

import { NETWORK_CONFIG } from '@/constants/network-config'
import type { WalletCoin } from '@/lib/wallet-core/types'
import { formatFeeReserve } from '@/utils/format'
import { selectByLargestFirst } from '@/utils/utxo'

import { FEE_WALLET_INPUT_WEIGHT_UNITS, weightUnitsToSats } from './weights'

export {
  estimateFeeBudgetSats,
  EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY,
  WALLET_OVERHEAD_WEIGHT_UNITS,
} from './weights'

// BIP-125 opt-in RBF sequence for wallet-controlled inputs, so a stuck broadcast can be
// fee-bumped instead of rejected with txn-mempool-conflict. Hard-coded (not
// TxSequence.enableRbfNoLocktime()) to avoid calling into the wasm module at import time.
// https://learnmeabitcoin.com/technical/transaction/input/sequence/#replace-by-fee
export const WALLET_INPUT_RBF_SEQUENCE = 0xfffffffd

export function utxoToOutpointString(utxo: WalletCoin): string {
  const outpoint = utxo.outpoint()
  return `${outpoint.txid().toString()}:${outpoint.vout()}`
}

export function findWalletUtxo(
  walletUtxos: WalletCoin[],
  outpoint: string,
): WalletCoin | undefined {
  const normalizedOutpoint = outpoint.trim()
  return walletUtxos.find(utxo => utxoToOutpointString(utxo) === normalizedOutpoint)
}

export function isConfirmedWalletUtxo(utxo: WalletCoin): boolean {
  return utxo.height() !== undefined
}

export function requireWalletUtxo(
  walletUtxos: WalletCoin[],
  outpoint: string,
  label: string,
): WalletCoin {
  const utxo = findWalletUtxo(walletUtxos, outpoint)
  if (!utxo) throw new Error(`${label} wallet UTXO not found`)
  if (!isConfirmedWalletUtxo(utxo)) throw new Error(`${label} wallet UTXO is not confirmed yet`)
  return utxo
}

export function assertWalletUtxoAssetAndMinimumAmount(
  utxo: WalletCoin,
  assetId: AssetId | string,
  minimumAmount: bigint,
  label: string,
): void {
  const unblinded = utxo.unblinded()
  const actualAssetId = unblinded.asset().toString()
  if (actualAssetId !== assetId.toString()) {
    throw new Error(`${label} UTXO has unexpected asset ${actualAssetId}`)
  }
  if (unblinded.value() < minimumAmount) {
    throw new Error(`${label} UTXO amount is lower than ${minimumAmount.toString()}`)
  }
}

export function selectAssetUtxos(
  walletUtxos: WalletCoin[],
  assetId: AssetId | string,
  amount: bigint,
  label: string,
): WalletCoin[] {
  const candidates = walletUtxos
    .filter(
      utxo =>
        isConfirmedWalletUtxo(utxo) && utxo.unblinded().asset().toString() === assetId.toString(),
    )
    .map(utxo => ({ value: utxo.unblinded().value(), utxo }))
  const selected = selectByLargestFirst(candidates, amount)
  if (!selected) throw new Error(`Insufficient confirmed ${label} balance`)
  return selected.map(item => item.utxo)
}

export function isPolicyAssetUtxo(utxo: WalletCoin, policyAsset: AssetId | string): boolean {
  return utxo.unblinded().asset().toString() === policyAsset.toString()
}

export function selectFeeUtxos(
  walletUtxos: WalletCoin[],
  policyAsset: AssetId | string,
  budgetSats: bigint,
  feeRateSatPerKvb: number,
): WalletCoin[] {
  const candidates = walletUtxos
    .filter(utxo => isConfirmedWalletUtxo(utxo) && isPolicyAssetUtxo(utxo, policyAsset))
    .map(utxo => ({ value: utxo.unblinded().value(), utxo }))
  const selected = selectByLargestFirst(candidates, budgetSats, {
    perItemReserve: weightUnitsToSats(FEE_WALLET_INPUT_WEIGHT_UNITS, feeRateSatPerKvb),
  })
  if (!selected) {
    throw new Error(
      `Insufficient confirmed ${NETWORK_CONFIG.collateralAsset.symbol} balance. This transaction requires a fee reserve of ${formatFeeReserve(budgetSats)}.`,
    )
  }
  return selected.map(item => item.utxo)
}
