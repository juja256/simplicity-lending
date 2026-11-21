export type PendingTxConfirmationStatus = 'processing' | 'confirmed' | 'finalized' | 'failed'

export type PrivateTxKind =
  | 'private_create_offer'
  | 'private_accept_offer'
  | 'private_cancel_offer'
  | 'private_claim_principal'
  | 'private_installment'
  | 'private_repay_offer'
  | 'private_zero_debt_close'
  | 'private_claim_installments'
  | 'private_claim_repayment'
  | 'private_liquidate_offer'

/**
 * The term a borrower chose for a creation, saved with it: every broadcast of the creation, a
 * retry's included, is refused once it could no longer count `termDays` (`creationSendable`).
 */
export interface CreationTerm {
  /** The creation's expiry, a block height (`proposalExpiry` of the tip and `termDays`). */
  loanExpirationTime: number
  termDays: number
}

/** A private lending transaction, saved finalized before its first broadcast. */
export interface PrivateTxRecord {
  txid: string
  kind: PrivateTxKind
  walletScriptPubkey: string
  /** The creation txid of the offer the transaction acts on; a creation's own txid. */
  offerTxid: string
  /** The finalized transaction, consensus hex. A retry rebroadcasts it; it is never rebuilt. */
  txHex: string
  /** `built` until a broadcast was accepted (or the transaction was seen confirmed). */
  broadcastStatus: 'built' | 'broadcast'
  confirmationStatus: PendingTxConfirmationStatus
  confirmations: number | null
  createdAt: number
  updatedAt: number
  /** Set once confirmations first reach the finalized threshold. */
  finalizedAt?: number
  errorMessage?: string
  /** A creation's term; absent for other kinds, and for a creation saved before it was kept. */
  creationTerm?: CreationTerm
  /**
   * When the borrower discarded this installment. The record stays, out of `privateTxs`, as the
   * discard's trace: the next installment of its loan must not start from its first wallet input
   * (`installmentTraceInputs`).
   */
  discardedAt?: number
}

export interface SavePrivateTxInput {
  txid: string
  kind: PrivateTxKind
  offerTxid: string
  txHex: string
  creationTerm?: CreationTerm
}

export interface PendingTransactionsContextValue {
  /** Private lending transactions of the connected wallet, saved before their broadcast. */
  privateTxs: PrivateTxRecord[]
  /** The installments the wallet discarded, kept as their discard's trace (`discardedAt`). */
  discardedTxs: PrivateTxRecord[]
  /**
   * Stores a finalized private transaction (status `built`) for the connected wallet. Rejects if
   * it could not be persisted, so the caller must not broadcast it.
   */
  savePrivateTx: (input: SavePrivateTxInput) => Promise<void>
  /** Updates a private transaction; a failure to persist the update is only logged. */
  updatePrivateTx: (txid: string, patch: Partial<PrivateTxRecord>) => Promise<void>
  /** Forgets a private transaction, for example a finalized one. */
  removePrivateTx: (txid: string) => Promise<void>
  /**
   * Drops a saved transaction the user gave up on. An installment is kept as the discard's trace
   * (`keepsDiscardTrace`), and the call rejects if that trace could not be persisted: the record
   * then stays as it was.
   */
  discardPrivateTx: (txid: string) => Promise<void>
}
