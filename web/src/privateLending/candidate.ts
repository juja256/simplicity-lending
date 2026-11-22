// The indexer's candidate of an offer (its status and the UTXOs it tracks), read for the
// outpoints an action spends. The candidate is untrusted: it only decides which action to offer
// and which outpoints to hand a builder, and the builder checks each one on chain. Free of the
// app's config, so the Node e2e script derives its inputs with the same rules.
import type { PrivateCandidateDetails, PrivateUtxo, PrivateUtxoType } from '@/api/indexer/private'
import {
  CREATION_OUTPUT,
  INSTALLMENT_OUTPUT,
  PRINCIPAL_CLAIM_OUTPUT,
} from '@/simplicity/private-lending/layout'

/** The first UTXO of a type the indexer tracks for the offer that is still unspent. */
export function unspentUtxo(
  candidate: PrivateCandidateDetails,
  type: PrivateUtxoType,
): PrivateUtxo | undefined {
  return candidate.utxos.find(utxo => utxo.utxo_type === type && utxo.spent_txid === null)
}

/**
 * The loan's carries the indexer lists unspent, `"<txid>:<vout>"`: the creation's carry supply
 * before the first installment, then the last installment's outputs 3 and 4. Untrusted: the
 * installment and the full repayment take them only when they are exactly the carries the loan
 * opens on chain (`verifiedLoanCarries`).
 */
export function unspentCarries(candidate: PrivateCandidateDetails): string[] {
  return candidate.utxos
    .filter(utxo => utxo.utxo_type === 'carry' && utxo.spent_txid === null)
    .map(utxoOutpoint)
}

/** The acceptance transaction, as the indexer saw it: the one that created the active offer. */
export function acceptanceTxid(candidate: PrivateCandidateDetails): string | undefined {
  return candidate.utxos.find(utxo => utxo.utxo_type === 'active_offer')?.txid
}

export function utxoOutpoint(utxo: PrivateUtxo): string {
  return `${utxo.txid}:${utxo.vout}`
}

/**
 * The loan's output as the indexer saw it: the one unspent now, or the last one, which the close or
 * the liquidation spent. An installment spends a loan output and creates the next, so the last is
 * the `active_offer` that no transaction creating another one spent. Undefined unless exactly one
 * is.
 */
export function latestLoanUtxo(candidate: PrivateCandidateDetails): PrivateUtxo | undefined {
  const loans = candidate.utxos.filter(utxo => utxo.utxo_type === 'active_offer')
  const successors = new Set(loans.map(utxo => utxo.txid))
  const last = loans.filter(utxo => utxo.spent_txid === null || !successors.has(utxo.spent_txid))
  return last.length === 1 ? last[0] : undefined
}

/**
 * The last loan output of a repaid offer, spent by its close (the full repayment), as the indexer
 * saw it: its `spent_txid` is the close. Undefined for an offer not repaid.
 */
export function closedLoanUtxo(candidate: PrivateCandidateDetails): PrivateUtxo | undefined {
  if (candidate.status !== 'repaid') return undefined
  const loan = latestLoanUtxo(candidate)
  return loan?.spent_txid === null ? undefined : loan
}

/**
 * The principal claim, as the indexer saw it: the transaction that spent the principal UTXO and
 * paid the borrower NFT back at its output 0. It is positive evidence only: undefined unless the
 * indexer lists a spent principal and no unspent one, and never the creation itself. A candidate
 * that omits the principal therefore gives no claim, rather than passing for a claimed one.
 */
export function principalClaimTxid(
  creationTxid: string,
  candidate: PrivateCandidateDetails,
): string | undefined {
  if (unspentUtxo(candidate, 'principal') !== undefined) return undefined
  const claim = candidate.utxos.find(
    utxo => utxo.utxo_type === 'principal' && utxo.spent_txid !== null,
  )?.spent_txid
  return claim && claim !== creationTxid ? claim : undefined
}

/**
 * Where the borrower NFT is, as the indexer saw it: output 0 of the principal claim once there is
 * one, output 0 of the creation before. For the actions that keep or must find the NFT where the
 * creation put it (the principal claim, the cancellation), never for a repayment, which burns it:
 * see `repaymentBorrowerNftOutpoint`.
 */
export function borrowerNftOutpoint(
  creationTxid: string,
  candidate: PrivateCandidateDetails,
): string {
  const claim = principalClaimTxid(creationTxid, candidate)
  return claim
    ? `${claim}:${PRINCIPAL_CLAIM_OUTPUT.borrowerNft}`
    : `${creationTxid}:${CREATION_OUTPUT.borrowerNft}`
}

/**
 * The borrower NFT a repayment spends: output 0 of the principal claim, or undefined without
 * evidence of the claim (`principalClaimTxid`). A repayment burns the borrower NFT, the only key to
 * an unclaimed principal, so it never falls back to the creation's output 0, and the Repay action
 * is offered only when this is defined. The builder then checks on chain that the transaction at
 * this outpoint spends the offer's principal.
 */
export function repaymentBorrowerNftOutpoint(
  creationTxid: string,
  candidate: PrivateCandidateDetails,
): string | undefined {
  const claim = principalClaimTxid(creationTxid, candidate)
  return claim === undefined ? undefined : `${claim}:${PRINCIPAL_CLAIM_OUTPUT.borrowerNft}`
}

/**
 * The borrower NFT that the next installment or the full repayment of a loan spends: output 0 of
 * its last installment (`installmentTxids`, read on chain), or before any,
 * `repaymentBorrowerNftOutpoint`. The builders walk it back on chain to the principal claim.
 */
export function loanBorrowerNftOutpoint(
  installmentTxids: readonly string[],
  creationTxid: string,
  candidate: PrivateCandidateDetails,
): string | undefined {
  const last = installmentTxids.at(-1)
  return last === undefined
    ? repaymentBorrowerNftOutpoint(creationTxid, candidate)
    : `${last}:${INSTALLMENT_OUTPUT.borrowerNft}`
}
