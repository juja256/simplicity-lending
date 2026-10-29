// Everything environment-specific that the private lending flow builders need. The app's hooks
// and the Node e2e harness each build one; the builders themselves stay DOM-free.
import type { Network, Transaction, WalletTxOut, Wollet } from '@lilbonekit/lwk-web'

import type { PrivateLendingSources } from '@/simplicity/private-lending/scripts'

export type PrivateNetworkName = 'liquid' | 'liquidtestnet' | 'regtest'

export interface PrivateFlowDeps {
  lwk: typeof import('@lilbonekit/lwk-web')
  wasm: typeof import('@/wasm/private-lending/private_lending_wasm')
  network: Network
  networkName: PrivateNetworkName
  sources: PrivateLendingSources
  wollet: Wollet
  /** The wallet's spendable coins. */
  walletUtxos: () => WalletTxOut[]
  fetchTx: (txid: string) => Promise<Transaction>
  /** Sat per kvb, or null for LWK's default. */
  feeRate: number | null
  assets: { collateral: string; principal: string; policy: string }
}
