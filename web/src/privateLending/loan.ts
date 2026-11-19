// A loan read from the chain for the party that opened its offer: its acceptance and its
// installments, walked back from the loan output the indexer gives, and the borrower NFT's way back
// to the principal claim. The indexer is untrusted, so every step is identified on chain: the
// acceptance by spending the offer's pending offer at input 0, each installment by holding the
// borrower NFT at output 0 and paying the installment lock at output 2. Only the borrower holds
// the borrower NFT, so nobody else can make a transaction that passes for an installment.
import type { Script, Transaction, TxOut } from 'lwk_wasm'

import {
  ACCEPTANCE_INPUT,
  ACCEPTANCE_OUTPUT,
  CREATION_OUTPUT,
  INSTALLMENT_INPUT,
  INSTALLMENT_OUTPUT,
  NFT_AMOUNT,
  PRINCIPAL_CLAIM_INPUT,
  PRINCIPAL_CLAIM_OUTPUT,
} from '@/simplicity/private-lending/layout'
import type { LendingKey, LoanState } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from './deps'
import { parseOutpoint, requireOutput, wasmStep } from './flows/shared'
import type { VerifiedOffer } from './verify'

/** A loan of a verified offer, read by `loadLoan`. */
export interface Loan {
  /** The loan's state for the party that opened the offer, after the installments below. */
  state: LoanState
  /** The acceptance: it spends the offer's pending offer at input 0, and holds loan output 0. */
  acceptanceTxid: string
  /** The installments in chain order: the `j`-th (from 1) holds loan output `j` at its output 1. */
  installmentTxids: string[]
}

/**
 * The most installments a walk follows: far more than any loan makes, and a bound on the
 * transactions a hostile indexer can make the app fetch.
 */
export const MAX_INSTALLMENTS = 200

/**
 * A step refused before building: the borrower NFT outpoint does not come from the claim of this
 * offer's principal (`principalClaimedBefore`), so the principal may be unclaimed. The borrower NFT
 * is the only key to it: the full repayment and the zero-debt close burn the NFT, and the app pays
 * no installment before the claim either. The message is `"principal-not-claimed: …"`.
 */
export class PrincipalNotClaimedError extends Error {
  readonly code = 'principal-not-claimed'

  constructor(
    readonly borrowerNftOutpoint: string,
    /** What was refused: `installment`, `repayment` or `zero-debt close`. */
    readonly action: string,
  ) {
    super(
      `principal-not-claimed: the borrower NFT at ${borrowerNftOutpoint} does not come from the ` +
        `claim of this offer's principal. Claim the principal before the ${action}: the borrower ` +
        'NFT is the only key to it',
    )
    this.name = 'PrincipalNotClaimedError'
  }
}

function spentAt(tx: Transaction, input: number): string | undefined {
  const outpoint = tx.inputs[input]?.outpoint()
  return outpoint && `${outpoint.txid().toString()}:${outpoint.vout()}`
}

/**
 * Whether `output` holds exactly one explicit unit of the borrower NFT, unburned: not at an
 * `OP_RETURN`, where the full repayment and the zero-debt close burn it.
 */
function holdsBorrowerNft(offer: VerifiedOffer, output: TxOut | undefined): boolean {
  return (
    output !== undefined &&
    output.asset()?.toString() === offer.opened.borrowerNft() &&
    output.value() === NFT_AMOUNT &&
    !output.scriptPubkey().isProvablyUnspendable()
  )
}

/** Whether `tx` spends the offer's pending offer at input 0: the acceptance or the cancellation. */
function spendsPendingOffer(offer: VerifiedOffer, tx: Transaction): boolean {
  const pendingOffer = `${offer.creationTx.txid().toString()}:${CREATION_OUTPUT.pendingOffer}`
  return spentAt(tx, ACCEPTANCE_INPUT.offer) === pendingOffer
}

/**
 * Whether `tx` has an installment's outputs for this offer: the borrower NFT at output 0, unburned,
 * and output 2 at the installment lock. Only the borrower can move the NFT.
 */
function isInstallment(offer: VerifiedOffer, tx: Transaction): boolean {
  const lock = tx.outputs[INSTALLMENT_OUTPUT.installment]
  return (
    holdsBorrowerNft(offer, tx.outputs[INSTALLMENT_OUTPUT.borrowerNft]) &&
    lock?.scriptPubkey().jet_sha256_hex() === offer.scripts.installmentOutputScriptHash
  )
}

async function fetchTx(deps: Pick<PrivateFlowDeps, 'fetchTx'>, txid: string): Promise<Transaction> {
  const tx = await deps.fetchTx(txid)
  if (tx.txid().toString() !== txid) throw new Error(`Fetched another transaction than ${txid}`)
  return tx
}

/**
 * The loan at `loanOutpoint` (`"<txid>:<vout>"`), read with `key`, the lending key of the party
 * that opened `offer`. It walks back with `deps.fetchTx`: each installment's input 1 is the
 * previous loan output, and the walk ends only at the offer's acceptance, the transaction that
 * spends its pending offer at input 0. Then `loanState` checks the commitments of the acceptance
 * and the installments, and this checks that every loan output is locked to the loan's script at
 * its debt hash (`activeOfferAt(state.debtHashAt(j))`).
 *
 * Throws, naming the transaction, unless the outpoint is a loan output of this offer: an output
 * someone sent to a loan's address, or a chain that does not lead back to the acceptance, is not.
 */
export async function loadLoan(
  deps: Pick<PrivateFlowDeps, 'fetchTx'>,
  offer: VerifiedOffer,
  key: LendingKey,
  loanOutpoint: string,
): Promise<Loan> {
  const start = parseOutpoint(loanOutpoint)
  const asked = `${start.txid}:${start.vout}`
  const installments: Transaction[] = []
  let at = start
  let acceptance: Transaction | undefined
  while (acceptance === undefined) {
    const tx = await fetchTx(deps, at.txid)
    const outpoint = `${at.txid}:${at.vout}`
    if (spendsPendingOffer(offer, tx)) {
      if (at.vout !== ACCEPTANCE_OUTPUT.activeOffer) {
        throw new Error(`${outpoint} is not the loan output of the acceptance ${at.txid}`)
      }
      acceptance = tx
    } else if (isInstallment(offer, tx)) {
      if (at.vout !== INSTALLMENT_OUTPUT.loan) {
        throw new Error(`${outpoint} is not the loan output of the installment ${at.txid}`)
      }
      if (installments.length >= MAX_INSTALLMENTS) {
        throw new Error(`The loan at ${asked} has more than ${MAX_INSTALLMENTS} installments`)
      }
      installments.unshift(tx)
      const previous = spentAt(tx, INSTALLMENT_INPUT.loan)
      if (previous === undefined) throw new Error(`The installment ${at.txid} has no input 1`)
      at = parseOutpoint(previous)
    } else {
      throw new Error(
        `The loan output ${asked} does not lead back to this offer's acceptance: ${at.txid} is ` +
          "neither this offer's acceptance nor one of its installments",
      )
    }
  }

  const state = wasmStep('Reading the loan', () =>
    offer.opened.loanState(
      key,
      acceptance.toString(),
      installments.map(tx => tx.toString()),
    ),
  )
  try {
    if (state.loanOutpoint !== asked) {
      throw new Error(`The loan read from ${asked} ends at ${state.loanOutpoint}`)
    }
    const loanOutputs: [string, TxOut | undefined][] = [
      [`${acceptance.txid().toString()}:${ACCEPTANCE_OUTPUT.activeOffer}`, acceptance.outputs[0]],
      ...installments.map((tx): [string, TxOut | undefined] => [
        `${tx.txid().toString()}:${INSTALLMENT_OUTPUT.loan}`,
        tx.outputs[INSTALLMENT_OUTPUT.loan],
      ]),
    ]
    loanOutputs.forEach(([outpoint, output], j) => {
      const script = offer.scripts.activeOfferAt(state.debtHashAt(j)).toString()
      if (output?.scriptPubkey().toString() !== script) {
        throw new Error(
          `Loan output ${j} (${outpoint}) is not locked to the loan's script at its debt`,
        )
      }
    })
  } catch (error) {
    state.free()
    throw error
  }
  return {
    state,
    acceptanceTxid: acceptance.txid().toString(),
    installmentTxids: installments.map(tx => tx.txid().toString()),
  }
}

/**
 * Whether the borrower NFT at `nftOutpoint` comes from the claim of this offer's principal. The
 * walk goes back through installments, each taking the NFT from output 0 at its input 0: output 0
 * of a principal claim gives true, a transaction whose input 0 spends output 1 of the offer's
 * acceptance (its principal). The creation's output 0, any output but 0, a burned NFT, or a
 * transaction that is neither a claim nor an installment give false.
 */
export async function principalClaimedBefore(
  deps: Pick<PrivateFlowDeps, 'fetchTx'>,
  offer: VerifiedOffer,
  nftOutpoint: string,
): Promise<boolean> {
  const creationTxid = offer.creationTx.txid().toString()
  let at = parseOutpoint(nftOutpoint)
  for (let step = 0; step <= MAX_INSTALLMENTS; step += 1) {
    // The creation, the principal claim and every installment hold the borrower NFT at output 0.
    if (at.vout !== PRINCIPAL_CLAIM_OUTPUT.borrowerNft || at.txid === creationTxid) return false
    const tx = await fetchTx(deps, at.txid)
    if (!holdsBorrowerNft(offer, tx.outputs[PRINCIPAL_CLAIM_OUTPUT.borrowerNft])) return false

    const claimed = spentAt(tx, PRINCIPAL_CLAIM_INPUT.principal)
    if (claimed !== undefined && parseOutpoint(claimed).vout === ACCEPTANCE_OUTPUT.principal) {
      // A claim: output 1 of the transaction that spends the pending offer, at the principal lock.
      const acceptance = await fetchTx(deps, parseOutpoint(claimed).txid)
      const principal = acceptance.outputs[ACCEPTANCE_OUTPUT.principal]
      return (
        spendsPendingOffer(offer, acceptance) &&
        principal?.scriptPubkey().jet_sha256_hex() === offer.scripts.principalOutputScriptHash
      )
    }
    if (!isInstallment(offer, tx)) return false
    const previous = spentAt(tx, INSTALLMENT_INPUT.borrowerNft)
    if (previous === undefined) return false
    at = parseOutpoint(previous)
  }
  return false
}

/** The borrower NFT and the loan output a borrower's step spends, fetched and checked on chain. */
export interface BorrowerLoanInputs {
  /** `"<txid>:<vout>"` of the borrower NFT, and its transaction. */
  nftInput: string
  nftTx: Transaction
  /** `"<txid>:<vout>"` of the loan output, `loan.state.loanOutpoint`, and its transaction. */
  loanInput: string
  loanTx: Transaction
  /** The loan's script at its debt: `activeOfferAt(loan.state.debtHash)`. */
  loanScript: Script
}

/**
 * What the installment, the full repayment and the zero-debt close spend first: the borrower NFT
 * at `borrowerNftOutpoint` and the loan output. Throws `PrincipalNotClaimedError` (naming `action`)
 * unless `principalClaimedBefore` holds, before anything else is fetched. Then the loan output
 * must be locked to the loan's script at its debt hash, and the NFT outpoint must hold exactly the
 * borrower NFT, explicit.
 */
export async function borrowerLoanInputs(
  deps: Pick<PrivateFlowDeps, 'fetchTx'>,
  offer: VerifiedOffer,
  loan: Loan,
  borrowerNftOutpoint: string,
  action: string,
): Promise<BorrowerLoanInputs> {
  const nftRef = parseOutpoint(borrowerNftOutpoint)
  const loanRef = parseOutpoint(loan.state.loanOutpoint)
  const nftInput = `${nftRef.txid}:${nftRef.vout}`
  const loanInput = `${loanRef.txid}:${loanRef.vout}`
  if (!(await principalClaimedBefore(deps, offer, nftInput))) {
    throw new PrincipalNotClaimedError(nftInput, action)
  }
  const [loanTx, nftTx] = await Promise.all([
    fetchTx(deps, loanRef.txid),
    fetchTx(deps, nftRef.txid),
  ])
  const loanScript = offer.scripts.activeOfferAt(loan.state.debtHash)
  const loanOutput = requireOutput(loanTx, loanRef.vout, 'The loan')
  if (loanOutput.scriptPubkey().toString() !== loanScript.toString()) {
    throw new Error(`The loan output ${loanInput} is not locked to the loan's script at its debt`)
  }
  if (!holdsBorrowerNft(offer, requireOutput(nftTx, nftRef.vout, 'The borrower NFT'))) {
    throw new Error('The borrower NFT outpoint does not hold exactly the borrower NFT, explicit')
  }
  return { nftInput, nftTx, loanInput, loanTx, loanScript }
}
