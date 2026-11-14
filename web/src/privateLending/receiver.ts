// The wallet's receive address for a builder's receiver. DOM-free, so the e2e script imports it.
import type { Address } from 'lwk_wasm'

import type { PrivateFlowDeps } from './deps'

/**
 * A fresh receive address of the wallet, a confidential one, for a builder's receiver: the last
 * unused external address, the one after the highest the wallet has used. It is address 0, the
 * wallet's identity (`walletIdentityScript`), only for a wallet with no transaction, which has no
 * coins to pay for a flow. Only a scan that sees a transaction advances it: applying a broadcast
 * (`applyBroadcastTransaction`) keeps the last unused index as it was. So a flow started before a
 * scan sees the previous flow's transaction gets the same receiver. That costs privacy only: the
 * funds still reach the wallet.
 */
export function walletReceiver(deps: Pick<PrivateFlowDeps, 'wollet'>): Address {
  return deps.wollet.address(null).address()
}
