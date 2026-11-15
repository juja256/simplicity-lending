// The wallet's receive address for a builder's receiver. DOM-free, so the e2e script imports it.
import type { Address } from 'lwk_wasm'

import type { PrivateFlowDeps } from './deps'

/**
 * A new receive address of the wallet, a confidential one, for a builder's receiver: the session's
 * `AddressCursor` hands out the next external address, never address 0 (the wallet's identity,
 * `walletIdentityScript`) and never one a restored wallet would not find. A flow started before a
 * scan sees the previous flow's transaction still gets a new one: applying a broadcast
 * (`applyBroadcastTransaction`) keeps LWK's last unused index as it was, but the cursor remembers
 * what it handed out.
 */
export function walletReceiver(deps: Pick<PrivateFlowDeps, 'wollet' | 'addresses'>): Address {
  return deps.addresses.nextReceive(deps.wollet)
}
