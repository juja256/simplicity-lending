import { type EsploraClient, type Transaction, TxOpt, type Wollet } from '@lilbonekit/lwk-web'

import type { WalletCoin } from '@/lib/wallet-core/types'

export interface WalletBalances {
  total: Record<string, string>
  confirmed: Record<string, string>
  /** total - confirmed per assetId. Only present for assets with a nonzero pending amount. */
  pending: Record<string, string>
}

function toWalletBalances(totals: Map<string, bigint>, coins: WalletCoin[]): WalletBalances {
  const confirmedAmounts = new Map<string, bigint>()
  for (const coin of coins) {
    if (coin.height() === undefined) continue
    const unblinded = coin.unblinded()
    const assetId = unblinded.asset().toString()
    confirmedAmounts.set(assetId, (confirmedAmounts.get(assetId) ?? 0n) + unblinded.value())
  }

  const total: Record<string, string> = {}
  const pending: Record<string, string> = {}
  for (const [assetId, totalAmount] of totals) {
    total[assetId] = totalAmount.toString()
    const pendingAmount = totalAmount - (confirmedAmounts.get(assetId) ?? 0n)
    if (pendingAmount !== 0n) pending[assetId] = pendingAmount.toString()
  }
  const confirmed: Record<string, string> = {}
  for (const [assetId, amount] of confirmedAmounts) {
    confirmed[assetId] = amount.toString()
  }

  return { total, confirmed, pending }
}

/**
 * Derives total/confirmed/pending balances from the wollet's current in-memory state.
 * No network calls — safe to call right after a local mutation like applyTransaction().
 */
export function readWalletBalances(wollet: Wollet): WalletBalances {
  const totals = new Map(wollet.balance().entries() as [string, bigint][])
  return toWalletBalances(totals, wollet.utxos())
}

const balanceScans = new WeakMap<Wollet, Promise<WalletBalances>>()

/**
 * Syncs wallet state via waterfalls fullScan and applies the update.
 * Manual and background refreshes share a scan: concurrent scans of the same WASM
 * wallet/client can violate Rust's borrowing rules and leave the scan unresolved.
 */
export function syncBalances(
  wollet: Wollet,
  esploraClient: EsploraClient,
): Promise<WalletBalances> {
  const inFlight = balanceScans.get(wollet)
  if (inFlight) return inFlight

  // Schedule the scan after storing its promise, including for synchronous failures.
  const scan = Promise.resolve()
    .then(async () => {
      const update = await esploraClient.fullScanToIndex(wollet, 0)
      if (update) wollet.applyUpdate(update)
      return readWalletBalances(wollet)
    })
    .finally(() => balanceScans.delete(wollet))
  balanceScans.set(wollet, scan)
  return scan
}

/**
 * Applies a just-broadcast transaction to the wallet's local state and returns the
 * updated balances immediately — no network round trip, so it can't race the indexer.
 * A later full scan (syncBalances) still reconciles confirmations over time.
 */
export function applyBroadcastTransaction(wollet: Wollet, tx: Transaction): WalletBalances {
  wollet.applyTransaction(tx)
  return readWalletBalances(wollet)
}

/**
 * Re-applies still-untracked self-broadcast txs after a full scan, in case that scan
 * was a stale snapshot that undid their local effect. Returns txids the indexer now
 * genuinely confirms, so the caller can stop tracking them.
 */
export function reconcilePendingBroadcasts(
  wollet: Wollet,
  pending: Map<string, Transaction>,
): string[] {
  const confirmedTxids: string[] = []
  for (const [txid, tx] of pending) {
    const height = wollet.txDetails(tx.txid(), TxOpt.default())?.height()
    if (height !== undefined) {
      confirmedTxids.push(txid)
      continue
    }
    try {
      wollet.applyTransaction(tx)
    } catch (err) {
      console.warn(err)
    }
  }
  return confirmedTxids
}

export function readCoinBalances(coins: WalletCoin[]): WalletBalances {
  const totals = new Map<string, bigint>()
  for (const coin of coins) {
    const unblinded = coin.unblinded()
    const assetId = unblinded.asset().toString()
    totals.set(assetId, (totals.get(assetId) ?? 0n) + unblinded.value())
  }
  return toWalletBalances(totals, coins)
}
