// The wallet's receive address for a builder's receiver. DOM-free, so the e2e script imports it.
import type { Address } from 'lwk_wasm'

import type { PrivateFlowDeps } from './deps'

/**
 * A fresh receive address of the wallet, a confidential one, for a builder's receiver: the last
 * unused external address, the one after the highest the wallet has used. It is address 0, the
 * wallet's identity (`walletIdentityScript`), only for a wallet with no transaction, which has no
 * coins to pay for a flow. The wallet must have applied its last broadcast transaction, or this
 * repeats that one's address.
 */
export function walletReceiver(deps: Pick<PrivateFlowDeps, 'wollet'>): Address {
  return deps.wollet.address(null).address()
}
