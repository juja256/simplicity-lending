// Everything environment-specific that the private lending flow builders need. The app's hooks
// and the Node e2e harness each build one; the builders themselves stay DOM-free.
import type { Network, Transaction, WalletTxOut, Wollet } from 'lwk_wasm'

import type { PrivateLendingSources } from '@/simplicity/private-lending/scripts'

export type PrivateNetworkName = 'liquid' | 'liquidtestnet' | 'regtest'

export interface PrivateFlowDeps {
  lwk: typeof import('lwk_wasm')
  wasm: typeof import('@/wasm/private-lending/private_lending_wasm')
  network: Network
  networkName: PrivateNetworkName
  sources: PrivateLendingSources
  wollet: Wollet
  /** The wallet's spendable coins. */
  walletUtxos: () => WalletTxOut[]
  fetchTx: (txid: string) => Promise<Transaction>
  /** The height of the chain tip, from esplora: the bound on the indexer's sync height. */
  fetchTipHeight: () => Promise<number>
  /** Sat per kvb: esplora's estimate, or `FALLBACK_FEE_RATE_SAT_PER_KVB` without a usable one. */
  feeRate: number
  assets: { collateral: string; principal: string; policy: string }
}
