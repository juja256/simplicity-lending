// The wallet's side of a private build: coin selection over the wallet's coins with their secrets
// (`WalletTxOut`), and the wallet's receive address. The public selection rules apply (confirmed
// coins, the fee reserve), and the picked coins keep their type.
import type { Address, WalletTxOut } from '@lilbonekit/lwk-web'

import { FALLBACK_FEE_RATE_SAT_PER_KVB } from '@/api/esplora/fee'
import { NETWORK_CONFIG } from '@/constants/network-config'
import {
  estimateFeeBudgetSats,
  isConfirmedWalletUtxo,
  selectAssetUtxos,
  selectFeeUtxos,
} from '@/lwk/utxo'
import { formatFeeReserve } from '@/utils/format'

import type { PrivateFlowDeps } from './deps'

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

/**
 * What a creation weighs beyond the wallet's first input, its change and the base transaction:
 * two issuances, the two explicit NFT outputs, the marker and the blinded pending offer. Testnet
 * creation 6816e8b1…682d weighs 12 466 WU with 4 wallet inputs, about 5 300 above that base.
 */
const CREATION_EXTRA_WEIGHT_UNITS = 6000

/** A creation's fee reserve with `inputs` wallet inputs, at `feeRate` sat/kvb. */
export function creationFeeBudgetSats(inputs: number, feeRate: number | null): bigint {
  return estimateFeeBudgetSats(
    CREATION_EXTRA_WEIGHT_UNITS,
    feeRate ?? FALLBACK_FEE_RATE_SAT_PER_KVB,
    inputs,
  )
}

/** The fewest coins a creation spends: one issues each NFT, and at least one pays the collateral. */
export const CREATION_MIN_COINS = 3

export interface CreationCoins<T> {
  /** Issues the borrower NFT; its outpoint becomes the offer's first input. */
  firstInput: T
  /** Issues the lender NFT. */
  lenderNftCoin: T
  /** Pay the collateral and, with the two coins above, the fee. */
  collateralCoins: T[]
}

/**
 * The coins of a creation, all of the collateral asset, which also pays the fee: the two smallest
 * issue the NFTs, and the largest of the others pay the collateral until they hold it and, with
 * the NFT coins, the fee reserve too. Throws a message for the user if the coins cannot.
 */
export function pickCreationCoins<T>(
  coins: readonly T[],
  valueOf: (coin: T) => bigint,
  collateralAmount: bigint,
  feeRate: number | null,
): CreationCoins<T> {
  const { symbol } = NETWORK_CONFIG.collateralAsset
  const sorted = coins
    .map(coin => ({ coin, value: valueOf(coin) }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
  const [first, second, ...rest] = sorted
  if (first === undefined || second === undefined || rest.length === 0) {
    throw new Error(
      `A private offer needs at least ${CREATION_MIN_COINS} confirmed ${symbol} coins: two ` +
        `issue its NFTs and the others pay the collateral and the fee. Your wallet has ` +
        `${sorted.length}. Send part of your balance to your own address to split it.`,
    )
  }
  const picked: typeof sorted = []
  let collateralIn = 0n
  const covered = () =>
    collateralIn >= collateralAmount &&
    first.value + second.value + collateralIn >=
      collateralAmount + creationFeeBudgetSats(2 + picked.length, feeRate)
  for (const candidate of rest.reverse()) {
    if (picked.length > 0 && covered()) break
    picked.push(candidate)
    collateralIn += candidate.value
  }
  if (!covered()) {
    throw new Error(
      `Your confirmed ${symbol} coins cannot pay this collateral and a fee reserve of ` +
        `${formatFeeReserve(creationFeeBudgetSats(2 + picked.length, feeRate))}: the two ` +
        `smallest issue the offer's NFTs, and the others must hold the collateral.`,
    )
  }
  return {
    firstInput: first.coin,
    lenderNftCoin: second.coin,
    collateralCoins: picked.map(({ coin }) => coin),
  }
}

/**
 * `pickCreationCoins` over the wallet's confirmed coins of the collateral asset. The creation pays
 * its fee from them, so the collateral asset must be the policy asset.
 */
export function selectCreationCoins(
  coins: WalletTxOut[],
  assets: PrivateFlowDeps['assets'],
  collateralAmount: bigint,
  feeRate: number | null,
): CreationCoins<WalletTxOut> {
  if (assets.collateral !== assets.policy) {
    throw new Error(
      'A private offer pays its fee from the collateral, so it must be the policy asset',
    )
  }
  const collateralCoins = coins.filter(
    coin =>
      isConfirmedWalletUtxo(coin) && coin.unblinded().asset().toString() === assets.collateral,
  )
  return pickCreationCoins(
    collateralCoins,
    coin => coin.unblinded().value(),
    collateralAmount,
    feeRate,
  )
}

/** The wallet's receive address, a confidential one, for a builder's receiver. */
export async function walletReceiver(
  deps: Pick<PrivateFlowDeps, 'lwk' | 'network'>,
  getReceiveAddress: () => Promise<string | null>,
): Promise<Address> {
  const address = await getReceiveAddress()
  if (!address) throw new Error('Missing wallet receive address')
  return deps.lwk.Address.parse(address, deps.network)
}
