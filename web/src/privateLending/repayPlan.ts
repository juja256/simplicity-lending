// The borrower's repay form as rules: the amount typed decides between an installment and the full
// repayment, and what the app refuses. With the rule that keeps a rebuilt installment from reusing
// the key of an earlier one that did not go through. Pure (no React, no app config), so tests
// import it.
import type { Transaction } from 'lwk_wasm'

import { FINALIZED_THRESHOLD, type PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { INSTALLMENT_INPUT } from '@/simplicity/private-lending/layout'

/** What the rules below need of LWK, which the app loads at run time (`getLwk`). */
type LwkTransactions = { Transaction: typeof Transaction }

/**
 * What the borrower's amount does: an installment below the remaining debt, the full repayment at
 * it, or nothing, with the reason in the borrower's words.
 */
export type RepayPlan =
  | { kind: 'installment'; amount: bigint }
  | { kind: 'full'; amount: bigint }
  | { kind: 'refused'; message: string }

export interface RepayPlanInput {
  /** What the loan still owes, in base units. */
  remaining: bigint
  /** The amount as the borrower typed it, in whole coins. */
  amountText: string
  /** The repayment asset's decimals and symbol, as the app's pair names it. */
  decimals: number
  symbol: string
  /** The chain tip, or 0 while it is not known. */
  tipHeight: number
  /** The loan's expiry, a block height. */
  expiry: number
}

/** Why no installment is paid from the expiry block on. */
export const INSTALLMENT_AFTER_TERM_NOTE =
  'The term has ended: the lender can take the collateral at any time. Repay in full to get it ' +
  'back.'

/** Why no installment is paid while the tip is not known. */
export const INSTALLMENT_TIP_UNKNOWN_NOTE =
  'Waiting for the chain tip: an installment is paid only before the term ends.'

const DECIMAL = /^(\d+)(?:\.(\d+))?$/

/**
 * Whether an installment may still be paid at `tipHeight`: the tip known and below the expiry.
 * From the expiry block on, the lender's liquidation can be mined in the same block as the
 * installment, and the lender would keep both: installments are not refunded.
 */
export function installmentTermOpen(tipHeight: number, expiry: number): boolean {
  return tipHeight > 0 && tipHeight < expiry
}

/**
 * Throws a message for the borrower unless `installmentTermOpen`: before an installment is built,
 * and again before it is broadcast, with the tip read at that moment.
 */
export function checkInstallmentTerm(tipHeight: number, expiry: number): void {
  if (!(tipHeight > 0)) throw new Error(INSTALLMENT_TIP_UNKNOWN_NOTE)
  if (!installmentTermOpen(tipHeight, expiry)) throw new Error(INSTALLMENT_AFTER_TERM_NOTE)
}

/** Base units as grouped whole coins: `1,100.5`. */
function grouped(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals)
  const fraction = (units % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  const whole = (units / base).toLocaleString('en-US')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

/**
 * The plan of the amount the borrower typed, on a loan that owes `remaining`. Below it, an
 * installment, which is refused from the expiry block on and while the tip is unknown; equal to
 * it, the full repayment, which takes the collateral back at any time; zero or above it, refused.
 */
export function repayPlan(input: RepayPlanInput): RepayPlan {
  const { remaining, decimals, symbol } = input
  const text = input.amountText.trim()
  if (text === '') return { kind: 'refused', message: 'Enter an amount above zero' }
  const match = DECIMAL.exec(text)
  if (match === null) return { kind: 'refused', message: 'Enter a number, such as 12 or 0.5' }
  const [, whole, fraction = ''] = match
  if (fraction.length > decimals) {
    return {
      kind: 'refused',
      message: `${symbol} has ${decimals} ${decimals === 1 ? 'decimal' : 'decimals'}`,
    }
  }
  const amount = BigInt(whole + fraction) * 10n ** BigInt(decimals - fraction.length)
  if (amount === 0n) return { kind: 'refused', message: 'Enter an amount above zero' }
  if (amount > remaining) {
    return {
      kind: 'refused',
      message: `That is more than you owe: at most ${grouped(remaining, decimals)} ${symbol}`,
    }
  }
  if (amount === remaining) return { kind: 'full', amount }
  if (input.tipHeight === 0) return { kind: 'refused', message: INSTALLMENT_TIP_UNKNOWN_NOTE }
  if (!installmentTermOpen(input.tipHeight, input.expiry)) {
    return { kind: 'refused', message: INSTALLMENT_AFTER_TERM_NOTE }
  }
  return { kind: 'installment', amount }
}

/** Why a saved installment is no longer broadcast once the term ended: only Discard is offered. */
export const INSTALLMENT_UNSENT_AFTER_TERM_NOTE =
  'The term has ended: the lender can take the collateral at any time, and keep an installment ' +
  'sent now.'

/**
 * How the repay form treats its broadcast: whether it sends an installment, which is checked
 * against a fresh tip before every broadcast, and why a saved one can no longer be sent (null while
 * it can). `saved` is the offer's saved, unsent transaction of the form, if any: its kind decides,
 * since it is broadcast as built, whatever the form now plans. The plan turns `refused` for the
 * same amount at the expiry, so it must not decide for a saved installment.
 */
export function repayBroadcast(
  saved: Pick<PrivateTxRecord, 'kind'> | undefined,
  plan: RepayPlan | undefined,
  tipHeight: number,
  expiry: number,
): { installment: boolean; blockedNote: string | null } {
  const installment =
    saved === undefined ? plan?.kind === 'installment' : saved.kind === 'private_installment'
  const blocked =
    installment && saved !== undefined && tipHeight > 0 && !installmentTermOpen(tipHeight, expiry)
  return { installment, blockedNote: blocked ? INSTALLMENT_UNSENT_AFTER_TERM_NOTE : null }
}

/**
 * Whether discarding the saved `record` keeps it as a trace: an installment does. Its key derives
 * from the loan outpoint, its first wallet input and the borrower NFT's receiver script, and a
 * rebuild with all three the same would derive it again. If the discarded one reached the network,
 * two range proofs with one nonce could both be public.
 */
export function keepsDiscardTrace(record: Pick<PrivateTxRecord, 'kind'>): boolean {
  return record.kind === 'private_installment'
}

/**
 * The first wallet inputs (input 2, `"<txid>:<vout>"`) of every installment this browser saved
 * that spent the loan at `loanOutpoint`, whatever became of it: discarded, failed (its tracking
 * timed out, as for a transaction the network dropped), or still waiting. The next installment of
 * that loan leaves these coins out, so that it never starts from one of them: any of them may
 * have reached the network under the key a rebuild would derive again. A waiting one blocks a
 * new build anyway, and a confirmed one spent the loan output, so neither costs a coin.
 */
export function installmentTraceInputs(
  lwk: LwkTransactions,
  saved: readonly PrivateTxRecord[],
  loanOutpoint: string,
): Set<string> {
  const inputs = new Set<string>()
  for (const record of saved) {
    if (!keepsDiscardTrace(record)) continue
    const { loan, firstWalletCoin } = installmentInputs(lwk, record)
    if (loan === loanOutpoint && firstWalletCoin !== undefined) inputs.add(firstWalletCoin)
  }
  return inputs
}

/** The loan output (input 1) a saved installment spends, `"<txid>:<vout>"`. */
export function installmentLoanOutpoint(
  lwk: LwkTransactions,
  record: Pick<PrivateTxRecord, 'txHex'>,
): string | undefined {
  return installmentInputs(lwk, record).loan
}

/** The loan output (input 1) and the first wallet input (input 2) a saved installment spends. */
function installmentInputs(
  lwk: LwkTransactions,
  record: Pick<PrivateTxRecord, 'txHex'>,
): { loan: string | undefined; firstWalletCoin: string | undefined } {
  const tx = lwk.Transaction.fromString(record.txHex)
  const outpointAt = (index: number) => {
    const outpoint = tx.inputs[index]?.outpoint()
    return outpoint && `${outpoint.txid().toString()}:${outpoint.vout()}`
  }
  return {
    loan: outpointAt(INSTALLMENT_INPUT.loan),
    firstWalletCoin: outpointAt(INSTALLMENT_INPUT.firstWalletCoin),
  }
}

/**
 * The installment traces that can go: the discarded or failed installments of `records` whose
 * loan output was spent with at least `FINALIZED_THRESHOLD` confirmations, the depth at which the
 * app forgets its own finalized transactions. `loanSpendDepth` gives the confirmations of the
 * spend of a loan outpoint (`"<txid>:<vout>"`): `null` while it is unspent (or not known), 0 while
 * the spend is in the mempool. A trace only keeps a rebuilt installment of the same loan output
 * from its first wallet input, so it can go once no installment can spend that output any more. A
 * spend in the mempool, or one less deep, can still drop, and the output be spent again.
 */
export function staleInstallmentRecords(
  lwk: LwkTransactions,
  records: readonly PrivateTxRecord[],
  loanSpendDepth: (outpoint: string) => number | null,
): PrivateTxRecord[] {
  return records.filter(record => {
    if (!isInstallmentTrace(record)) return false
    const loan = installmentLoanOutpoint(lwk, record)
    if (loan === undefined) return false
    const depth = loanSpendDepth(loan)
    return depth !== null && depth >= FINALIZED_THRESHOLD
  })
}

/**
 * Whether `record` is kept only as a trace: an installment discarded, or failed (its tracking
 * timed out), which the pending-transactions sweep no longer tracks or forgets.
 */
export function isInstallmentTrace(record: PrivateTxRecord): boolean {
  return (
    keepsDiscardTrace(record) &&
    (record.discardedAt !== undefined || record.confirmationStatus === 'failed')
  )
}
