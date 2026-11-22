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
  CARRY_SUPPLY,
  CREATION_INPUT,
  CREATION_OUTPUT,
  INSTALLMENT_INPUT,
  INSTALLMENT_OUTPUT,
  MAX_LOAN_INSTALLMENTS,
  NFT_AMOUNT,
  PRINCIPAL_CLAIM_INPUT,
  PRINCIPAL_CLAIM_OUTPUT,
} from '@/simplicity/private-lending/layout'
import { hexToBytes } from '@/utils/hex'
import type { Carry, LendingKey, LoanState } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from './deps'
import { pinnedAuthCovenant } from './finalize'
import { fetchPrevoutTxs, parseOutpoint, prevoutsOf, requireOutput, wasmStep } from './flows/shared'
import type { VerifiedOffer } from './verify'

/** A loan of a verified offer, read by `loadLoan`. */
export interface Loan {
  /** The loan's state for the party that opened the offer, after the installments below. */
  state: LoanState
  /** The acceptance: it spends the offer's pending offer at input 0, and holds loan output 0. */
  acceptanceTxid: string
  /** The installments in chain order: the `j`-th (from 1) holds loan output `j` at its output 1. */
  installmentTxids: string[]
  /** The acceptance as read, in hex: a new installment is read back with it before signing. */
  acceptanceHex: string
  /** The installments as read, in hex and in chain order. */
  installmentHexes: string[]
}

/**
 * The most installments a walk follows: the most a loan can have, since the release proof's tree
 * has 1024 leaves (the contract refuses an installment at step 1024), and a bound on the
 * transactions a hostile indexer can make the app fetch.
 */
export const MAX_INSTALLMENTS = MAX_LOAN_INSTALLMENTS

/**
 * A step refused before building: the borrower NFT outpoint does not come from the claim of this
 * offer's principal (`principalClaimedBefore`), so the principal may be unclaimed. The borrower NFT
 * is the only key to it: the full repayment burns the NFT, and the app pays no installment before
 * the claim either. The message is `"principal-not-claimed: …"`.
 */
export class PrincipalNotClaimedError extends Error {
  readonly code = 'principal-not-claimed'

  constructor(
    readonly borrowerNftOutpoint: string,
    /** What was refused: `installment` or `repayment`. */
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
 * `OP_RETURN`, where the full repayment and the cancellation burn it.
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
    acceptanceHex: acceptance.toString(),
    installmentHexes: installments.map(tx => tx.toString()),
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
 * What the installment and the full repayment spend first: the borrower NFT
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

/** The creation's carry supply: the loan's carry before its first installment. */
export interface CarrySupply {
  /** `"<creation txid>:4"`. */
  outpoint: string
  /** The carry token, issued at the creation's input 2. */
  asset: string
  /** `CARRY_SUPPLY` units, explicit. */
  amount: bigint
}

/**
 * The creation's carry supply of `offer`, checked on its creation transaction (the gate's): output
 * 4 holds `CARRY_SUPPLY` explicit units of the asset that input 2 newly issues, exactly that many
 * and no reissuance token, at the principal's asset_auth, which the borrower NFT unlocks. Throws
 * otherwise: an offer without it cannot be cancelled nor take an installment.
 */
export function creationCarrySupply(deps: PrivateFlowDeps, offer: VerifiedOffer): CarrySupply {
  const { lwk } = deps
  const tx = offer.creationTx
  const outpoint = `${tx.txid().toString()}:${CREATION_OUTPUT.carrySupply}`
  const output = requireOutput(tx, CREATION_OUTPUT.carrySupply, 'The carry supply')
  const issuance = newIssuance(tx.toString(), CREATION_INPUT.carryIssuance)
  const issued =
    issuance &&
    lwk
      .assetIdFromIssuance(
        new lwk.OutPoint(issuance.outpoint),
        lwk.ContractHash.fromBytes(issuance.contractHash),
      )
      .toString()
  const asset = output.asset()?.toString()
  if (
    issued === undefined ||
    issuance?.amount !== CARRY_SUPPLY ||
    issuance.inflationKeys !== null ||
    asset !== issued ||
    output.value() !== CARRY_SUPPLY
  ) {
    throw new Error(
      `The creation's output ${CREATION_OUTPUT.carrySupply} is not the carry supply: ` +
        `${CARRY_SUPPLY} explicit units of the asset its input ${CREATION_INPUT.carryIssuance} ` +
        'issues',
    )
  }
  if (
    output.scriptPubkey().toString() !==
    pinnedAuthCovenant(deps, offer, 'principal').script.toString()
  ) {
    throw new Error("The carry supply is not locked to the offer's principal asset_auth")
  }
  return { outpoint, asset, amount: CARRY_SUPPLY }
}

/** A new issuance of a transaction input, read from its consensus encoding. */
interface InputIssuance {
  /** The outpoint the input spends, `"<txid>:<vout>"`. */
  outpoint: string
  /** The issuance's asset entropy field: for a new issuance, the contract hash (32 bytes). */
  contractHash: Uint8Array
  /** The explicit amount issued; null for none, `'confidential'` for a blinded one. */
  amount: bigint | null | 'confidential'
  inflationKeys: bigint | null | 'confidential'
}

/**
 * The new issuance of input `index` of the transaction `txHex` (Elements' encoding), or undefined
 * when it has none or reissues. LWK's `TxIn` does not expose issuances, so this reads the bytes.
 */
export function newIssuance(txHex: string, index: number): InputIssuance | undefined {
  const bytes = hexToBytes(txHex)
  let at = 0
  const take = (length: number) => {
    if (at + length > bytes.length) throw new Error('The transaction ends early')
    const slice = bytes.subarray(at, at + length)
    at += length
    return slice
  }
  const le = (slice: Uint8Array) =>
    slice.reduceRight((value, byte) => value * 256n + BigInt(byte), 0n)
  const varInt = () => {
    const first = take(1)[0]
    if (first < 0xfd) return first
    return Number(le(take(first === 0xfd ? 2 : first === 0xfe ? 4 : 8)))
  }
  const confidentialValue = (): bigint | null | 'confidential' => {
    const prefix = take(1)[0]
    if (prefix === 0) return null
    if (prefix === 1) return [...take(8)].reduce((value, byte) => value * 256n + BigInt(byte), 0n)
    take(32)
    return 'confidential'
  }
  const hex = (slice: Uint8Array) =>
    [...slice].map(byte => byte.toString(16).padStart(2, '0')).join('')
  take(4) // version
  take(1) // the witness flag
  const inputs = varInt()
  for (let input = 0; input < inputs; input += 1) {
    const txid = hex(take(32).slice().reverse())
    const vout = Number(le(take(4)))
    take(varInt()) // scriptSig
    take(4) // sequence
    const hasIssuance = (vout & 0x80000000) !== 0
    if (!hasIssuance) {
      if (input === index) return undefined
      continue
    }
    const nonce = take(32)
    const contractHash = take(32).slice()
    const amount = confidentialValue()
    const inflationKeys = confidentialValue()
    if (input === index) {
      // a reissuance carries the token's blinding nonce; a new issuance a zero one
      if (nonce.some(byte => byte !== 0)) return undefined
      return { outpoint: `${txid}:${vout & 0x3fffffff}`, contractHash, amount, inflationKeys }
    }
  }
  return undefined
}

/** A loan's carry, opened by the borrower from the chain and checked there. */
export interface LoanCarry {
  /** The wasm's carry, which gives its input secret: the caller frees it. */
  carry: Carry
  outpoint: string
  asset: string
  amount: bigint
  /** The carry's output, as found on chain. */
  prevout: TxOut
}

/**
 * The carries the borrower's next installment or full repayment spends, verified on chain (review
 * focus 4). The indexer, untrusted, names them (`indexerCarries`, `"<txid>:<vout>"`): they must be
 * exactly the carries `loan.state.carries()` opens from the loan's own transactions, which
 * `loadLoan` walked on chain: the creation's output 4 before the first installment (checked by
 * `creationCarrySupply`), then the last installment's outputs 3 and 4. Each must be locked to the
 * offer's principal asset_auth, which the borrower NFT unlocks. Throws otherwise, naming the carry
 * the indexer got wrong. The caller frees each `carry`.
 */
export async function verifiedLoanCarries(
  deps: PrivateFlowDeps,
  offer: VerifiedOffer,
  loan: Loan,
  indexerCarries: readonly string[],
): Promise<LoanCarry[]> {
  const opened = wasmStep("Opening the loan's carries", () => loan.state.carries())
  try {
    const outpoints = opened.map(carry => carry.outpoint)
    const named = new Set(
      indexerCarries.map(outpoint => {
        const { txid, vout } = parseOutpoint(outpoint)
        return `${txid}:${vout}`
      }),
    )
    for (const outpoint of named) {
      if (!outpoints.includes(outpoint)) {
        throw new Error(
          `The indexer names ${outpoint} as a carry of this loan, but the loan's carries on chain ` +
            `are ${outpoints.join(' and ')}`,
        )
      }
    }
    for (const outpoint of outpoints) {
      if (!named.has(outpoint)) {
        throw new Error(`The indexer does not list the loan's carry ${outpoint} as unspent`)
      }
    }
    const step = loan.state.installmentCount
    const expected =
      step === 0
        ? [creationCarrySupply(deps, offer).outpoint]
        : [INSTALLMENT_OUTPUT.carry, INSTALLMENT_OUTPUT.secondCarry].map(
            vout => `${loan.installmentTxids[step - 1]}:${vout}`,
          )
    if (outpoints.length !== expected.length || outpoints.some((o, i) => o !== expected[i])) {
      throw new Error(`The loan's carries are not ${expected.join(' and ')}`)
    }
    const txs = await fetchPrevoutTxs(deps, outpoints)
    const lock = pinnedAuthCovenant(deps, offer, 'principal').script.toString()
    const prevouts = prevoutsOf(txs, outpoints)
    return opened.map((carry, index) => {
      const prevout = prevouts[index]
      if (prevout.scriptPubkey().toString() !== lock) {
        throw new Error(
          `The carry ${carry.outpoint} is not locked to the offer's principal asset_auth`,
        )
      }
      return { carry, outpoint: carry.outpoint, asset: carry.asset, amount: carry.amount, prevout }
    })
  } catch (error) {
    opened.forEach(carry => carry.free())
    throw error
  }
}
