// A loan's private messages, as its timeline shows them: what each party reads from the chain,
// and what this browser recorded of its own.
//
// The creation's message is part of the signed terms, and both parties read it. The acceptance's
// is the lender's to the borrower: only the borrower reads it from the chain, as its nonce is
// random. Each installment's is the borrower's, and both read it. The full repayment's is the
// borrower's, and only the lender reads it. So the lender's own acceptance and the borrower's own
// full repayment come from the record of sent messages (`sentMessages.ts`), matched by txid only:
// a discarded draft's record names a transaction that is not on chain, and never shows. A sender
// on another browser has no record, and its message has no entry.
import { ACCEPTANCE_OUTPUT } from '@/simplicity/private-lending/layout'
import type { LendingKey, ReadMessage } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from './deps'
import type { Loan } from './loan'
import type { SentMessage } from './sentMessages'
import type { VerifiedOffer } from './verify'

/** One message of a loan's timeline. */
export interface LoanMessage {
  phase: 'creation' | 'acceptance' | 'installment' | 'repayment'
  /** The installment's index, from 1; only for `installment`. */
  installment?: number
  from: 'borrower' | 'lender'
  /** The transaction that carries it: the creation's txid for `creation`. */
  txid: string
  /**
   * `verified` when its sender signed it for this step of this loan (the creation's, by the
   * terms' signature); `unverified` when not, as the other party, who knows the output's
   * blinders, may have moved it there; `unreadable` when its field does not decode; `sent` for
   * this wallet's own, from its record.
   */
  state: 'verified' | 'unverified' | 'unreadable' | 'sent'
  /** The text as sent, before `displayMessage`; absent when `unreadable`. */
  text?: string
}

/**
 * A message as read from the chain: its fields, copied out of the wasm's `ReadMessage`, or
 * `unreadable` when the wasm refused its field.
 */
export type MessageRead = Pick<ReadMessage, 'text' | 'verified'> | 'unreadable'

/** A transaction of the loan, and what its output read as: undefined for no message read. */
export interface ChainMessage {
  txid: string
  read?: MessageRead
}

/** What `collectLoanMessages` takes: the reads of one party, and this wallet's records. */
export interface LoanMessagesInput {
  role: 'lender' | 'borrower'
  /** The offer's creation txid. */
  offerTxid: string
  /** The creation's text, from the signed terms. */
  creation?: string
  acceptance?: ChainMessage
  /** The installments, each with its index from 1. */
  installments: (ChainMessage & { j: number })[]
  /** The full repayment, when the loan closed with one. */
  repayment?: ChainMessage
  /** This wallet's records for the offer (`SentMessages.forOffer`). */
  sent: SentMessage[]
}

/**
 * The message of one transaction: its chain read; or, for a transaction this wallet sent, the
 * text of its record with the same txid; or none.
 */
function entry(
  base: Pick<LoanMessage, 'phase' | 'installment' | 'from' | 'txid'>,
  read: MessageRead | undefined,
  role: LoanMessagesInput['role'],
  sent: readonly SentMessage[],
): LoanMessage[] {
  if (read === 'unreadable') return [{ ...base, state: 'unreadable' }]
  if (read !== undefined) {
    return [{ ...base, state: read.verified ? 'verified' : 'unverified', text: read.text }]
  }
  if (base.from !== role) return []
  const text = sent.find(record => record.txid === base.txid)?.text
  return text === undefined ? [] : [{ ...base, state: 'sent', text }]
}

/**
 * A loan's messages in chain order: the creation's, the acceptance's, each installment's by index,
 * the full repayment's. A phase this wallet sent and cannot read from the chain takes its text from
 * the `sent` record with the same txid; with no such record, or one without text, it has no entry.
 */
export function collectLoanMessages(input: LoanMessagesInput): LoanMessage[] {
  const { role, offerTxid, creation, acceptance, installments, repayment, sent } = input
  const messages: LoanMessage[] = []
  if (creation !== undefined) {
    messages.push({
      phase: 'creation',
      from: 'borrower',
      txid: offerTxid,
      state: 'verified',
      text: creation,
    })
  }
  if (acceptance !== undefined) {
    const base = { phase: 'acceptance', from: 'lender', txid: acceptance.txid } as const
    messages.push(...entry(base, acceptance.read, role, sent))
  }
  for (const { txid, j, read } of [...installments].sort((a, b) => a.j - b.j)) {
    const base = { phase: 'installment', installment: j, from: 'borrower', txid } as const
    messages.push(...entry(base, read, role, sent))
  }
  if (repayment !== undefined) {
    const base = { phase: 'repayment', from: 'borrower', txid: repayment.txid } as const
    messages.push(...entry(base, repayment.read, role, sent))
  }
  return messages
}

/**
 * The fields of the message `read` gives, copied before it is freed; undefined for none. Whatever
 * it throws (the wasm's `bad-input` for a field that does not decode) reads as `unreadable`: a
 * message never stops the loan from being read.
 */
export function copyMessage(read: () => ReadMessage | undefined): MessageRead | undefined {
  let message: ReadMessage | undefined
  try {
    message = read()
    return message === undefined ? undefined : { text: message.text, verified: message.verified }
  } catch {
    return 'unreadable'
  } finally {
    message?.free()
  }
}

/** The messages of a loan's acceptance and installments, as one party reads them on chain. */
export interface LoanChainMessages {
  acceptance: ChainMessage
  installments: (ChainMessage & { j: number })[]
}

/**
 * The messages `loan` carries for the party of `role`, whose lending key is `key`: each
 * installment's from the loan's state, and for the borrower the acceptance's, read from its
 * principal output. The lender cannot read its own acceptance, so it reads none.
 */
export function loanChainMessages(
  wasm: PrivateFlowDeps['wasm'],
  offer: VerifiedOffer,
  key: LendingKey,
  role: LoanMessagesInput['role'],
  loan: Loan,
): LoanChainMessages {
  const acceptance: ChainMessage = { txid: loan.acceptanceTxid }
  if (role === 'borrower') {
    acceptance.read = copyMessage(() =>
      offer.opened.readMessage(
        key,
        offer.creationTx.txid().toString(),
        loan.acceptanceHex,
        ACCEPTANCE_OUTPUT.principal,
        wasm.MessagePhase.Acceptance,
      ),
    )
  }
  const installments = loan.installmentTxids.map((txid, index) => {
    const j = index + 1
    const info = loan.state.installment(j)
    try {
      return { txid, j, read: copyMessage(() => info.message) }
    } finally {
      info.free()
    }
  })
  return { acceptance, installments }
}
