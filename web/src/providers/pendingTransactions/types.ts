import type { OfferStatus } from '@/api/indexer/schemas'

export type PendingTxKind =
  | 'create_borrower_account'
  | 'create_offer'
  | 'accept_offer'
  | 'cancel_offer'
  | 'claim_principal'
  | 'repay_offer'
  | 'claim_interest'
  | 'liquidate_offer'

export type PendingTxConfirmationStatus = 'processing' | 'confirmed' | 'finalized' | 'failed'

export interface PendingTxRecord {
  txid: string
  kind: PendingTxKind
  walletScriptPubkey: string
  offerId?: string
  previousOfferStatus?: OfferStatus
  expectedOfferStatus?: OfferStatus
  confirmationStatus: PendingTxConfirmationStatus
  confirmations: number | null
  createdAt: number
  updatedAt: number
  /** Set once confirmations first reach the finalized threshold. */
  finalizedAt?: number
  lastIndexerCheckAt?: number
  errorMessage?: string
}

export interface AddPendingTxInput {
  txid: string
  kind: PendingTxKind
  walletScriptPubkey: string
  offerId?: string
  previousOfferStatus?: OfferStatus
  expectedOfferStatus?: OfferStatus
}

export type PrivateTxKind =
  | 'private_create_offer'
  | 'private_accept_offer'
  | 'private_cancel_offer'
  | 'private_claim_principal'
  | 'private_repay_offer'
  | 'private_claim_repayment'
  | 'private_liquidate_offer'

/**
 * A private lending transaction, saved finalized before its first broadcast. Kept apart from
 * `PendingTxRecord` (its own IndexedDB database and state), so public pages never see it.
 */
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
}

export interface SavePrivateTxInput {
  txid: string
  kind: PrivateTxKind
  offerTxid: string
  txHex: string
}

export interface PendingTransactionsContextValue {
  /** Pending tx records scoped to the currently connected wallet. */
  pendingTxs: PendingTxRecord[]
  newlyCreatedOfferIds: ReadonlySet<string>
  highlightedCreatedOfferIds: ReadonlySet<string>
  isLoading: boolean
  addPendingTx: (input: AddPendingTxInput) => Promise<void>
  updatePendingTx: (txid: string, patch: Partial<PendingTxRecord>) => Promise<void>
  removePendingTx: (txid: string) => Promise<void>
  /**
   * Marks a txid as "surfaced": the user closed its transaction modal while still pending, so
   * the bottom-center toast should pick up tracking it. Tracking continues even if a modal that
   * stayed open the whole time never calls this.
   */
  addSurfaceToast: (txid: string) => void
  startCreatedOfferHighlight: (offerId: string) => void
  /** Private lending transactions of the connected wallet, saved before their broadcast. */
  privateTxs: PrivateTxRecord[]
  /**
   * Stores a finalized private transaction (status `built`) for the connected wallet. Rejects if
   * it could not be persisted, so the caller must not broadcast it.
   */
  savePrivateTx: (input: SavePrivateTxInput) => Promise<void>
  /** Updates a private transaction; a failure to persist the update is only logged. */
  updatePrivateTx: (txid: string, patch: Partial<PrivateTxRecord>) => Promise<void>
  /** Forgets a private transaction, for example one the user gave up on. */
  removePrivateTx: (txid: string) => Promise<void>
}
