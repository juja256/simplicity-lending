// The wallet's identity: the script of its first address. Saved private transactions are keyed by
// it, so it must stay what it was, but it is never a receiver: every flow receives at a fresh
// address (`walletReceiver`).
import type { Wollet } from 'lwk_wasm'

/** The hex script of the wallet's address 0, its identity and never a receiver. */
export function walletIdentityScript(wollet: Wollet): string {
  return wollet.address(0).address().scriptPubkey().toString()
}
