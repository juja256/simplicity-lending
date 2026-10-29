// The shape every transaction builder returns. Free of app imports, so the DOM-free private flow
// builders and the Node e2e script can use it.
import type { Pset, Transaction } from '@lilbonekit/lwk-web'

// PSBT/PSET roles (BIP174): Creator+Constructor+Updater have already run by the time a
// domain hook hands back `pset` — it has inputs, outputs, and signing data, just no
// signature yet. `finalize` covers Input Finalizer + Transaction Extractor, run after
// the caller signs (Signer role) in between.
export interface UpdatedPset<TSummary> {
  pset: Pset
  finalize: (signedPset: Pset) => { finalizedTx: Transaction; summary: TSummary }
}

/**
 * `UpdatedPset` with an async `finalize`, for flows whose finalization runs an async check: the
 * private offer creation runs the borrower's self-check (`openAndVerifyOffer`).
 */
export interface AsyncUpdatedPset<TSummary> {
  pset: Pset
  finalize: (signedPset: Pset) => Promise<{ finalizedTx: Transaction; summary: TSummary }>
}
