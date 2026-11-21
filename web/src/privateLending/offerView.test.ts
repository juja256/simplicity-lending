import { describe, expect, it, vi } from 'vitest'

import type { PrivateCandidateDetails, PrivateOfferStatus } from '@/api/indexer/private'
import type { PrivateTxRecord } from '@/providers/pendingTransactions/types'

import type { LoanFigures } from './hooks/useLoan'
import type { PrivateOfferItem } from './hooks/usePrivateOffers'
import { proposalExpiry, TERM_MARGIN_BLOCKS } from './lenderTerms'
import {
  borrowerActions,
  borrowerSendable,
  borrowerStatus,
  borrowerView,
  canStillAccept,
  checkCreationSendable,
  checkStillAcceptable,
  creationExpiredNote,
  creationSendable,
  displayStatus,
  dueText,
  LENDER_ACTION_LABELS,
  type LenderAction,
  lenderSendable,
  lenderView,
  type OfferActions,
  offerActionState,
  type OpenedOfferItem,
} from './offerView'

const COLLATERAL = 'c0'.repeat(32)
const PRINCIPAL = 'd0'.repeat(32)

// The app's pair comes from the build settings; the rules here only compare asset ids with it.
vi.mock('@/constants/network-config', () => ({
  NETWORK_CONFIG: {
    collateralAsset: { id: 'c0'.repeat(32), decimals: 8, symbol: 'tL-BTC' },
    principalAsset: { id: 'd0'.repeat(32), decimals: 8, symbol: 'TEST' },
    policyAssetSatsUnit: 'sats',
  },
}))

const EXPIRY = 3_000_000
const TXID = 'ab'.repeat(32)

function pending(status: PrivateOfferStatus = 'pending'): OpenedOfferItem {
  const candidate = {
    creation_txid: TXID,
    status,
    created_at_height: EXPIRY - 30 * 1440,
    updated_at_height: EXPIRY - 30 * 1440,
    utxos: [
      {
        utxo_type: 'pending_offer',
        txid: TXID,
        vout: 3,
        created_at_height: EXPIRY - 30 * 1440,
        spent_txid: null,
        spent_at_height: null,
      },
    ],
  } as unknown as PrivateCandidateDetails
  return {
    txid: TXID,
    role: 'lender',
    result: 'verified',
    candidate,
    terms: {
      borrowerPublicKey: 'b'.repeat(64),
      borrowerFingerprint: 'b'.repeat(16),
      lenderPublicKey: 'a'.repeat(64),
      lenderFingerprint: 'a'.repeat(16),
      collateralAsset: COLLATERAL,
      collateralAmount: 10n,
      principalAsset: PRINCIPAL,
      principalAmount: 1_000n,
      repaymentAmount: 1_100n,
      interest: 100n,
      loanExpirationTime: EXPIRY,
      borrowerNft: 'e'.repeat(64),
      lenderNft: 'f'.repeat(64),
    },
  }
}

function unsentAcceptance(item: PrivateOfferItem): PrivateTxRecord {
  return unsent(item, 'private_accept_offer')
}

function unsent(item: PrivateOfferItem, kind: PrivateTxRecord['kind']): PrivateTxRecord {
  return {
    txid: 'cd'.repeat(32),
    kind,
    walletScriptPubkey: '0014' + '00'.repeat(20),
    offerTxid: item.txid,
    txHex: '00',
    broadcastStatus: 'built',
    confirmationStatus: 'processing',
    confirmations: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

const PROPOSAL_ACTIONS: OfferActions<LenderAction, 'private_accept_offer'> = {
  labels: LENDER_ACTION_LABELS,
  danger: 'liquidate',
  actionOfKind: { private_accept_offer: 'accept' },
}

/** The proposals page's state of `item` at `tip`, with `txs` saved in this browser. */
function proposalState(item: OpenedOfferItem, tip: number, txs: PrivateTxRecord[] = []) {
  return offerActionState(
    txs,
    item,
    PROPOSAL_ACTIONS,
    opened => lenderView(opened, tip),
    lenderSendable(tip),
  )
}

describe('the acceptance window', () => {
  it('is open while the tip is known and below the expiry', () => {
    const { terms } = pending()
    expect(canStillAccept(terms, EXPIRY - 1)).toBe(true)
    expect(canStillAccept(terms, EXPIRY)).toBe(false)
    expect(canStillAccept(terms, EXPIRY + 1)).toBe(false)
    expect(canStillAccept(terms, 0)).toBe(false)
  })

  it('refuses a build or a broadcast at or past the expiry, or with the tip unknown', () => {
    const { terms } = pending()
    expect(() => checkStillAcceptable(terms, EXPIRY - 1)).not.toThrow()
    expect(() => checkStillAcceptable(terms, EXPIRY)).toThrow('Its term has passed.')
    expect(() => checkStillAcceptable(terms, EXPIRY + 5)).toThrow('Its term has passed.')
    expect(() => checkStillAcceptable(terms, 0)).toThrow('The chain tip is not known')
  })
})

describe('lenderView of a pending proposal', () => {
  it('offers Review before the expiry', () => {
    expect(lenderView(pending(), EXPIRY - 1)).toEqual({ action: 'accept' })
  })

  it('offers nothing while the tip is unknown', () => {
    expect(lenderView(pending(), 0)).toEqual({ note: 'Waiting for the chain tip.' })
  })

  it('offers nothing once its term has passed, from the expiry block on', () => {
    expect(lenderView(pending(), EXPIRY)).toEqual({ note: 'Its term has passed.' })
    expect(lenderView(pending(), EXPIRY + 1)).toEqual({ note: 'Its term has passed.' })
  })
})

describe('offerActionState of a proposal', () => {
  it('reviews a live proposal', () => {
    const item = pending()
    expect(proposalState(item, EXPIRY - 1).button).toMatchObject({
      kind: 'open',
      action: 'accept',
      label: 'Review',
    })
  })

  it('broadcasts an unsent acceptance again before the expiry', () => {
    const item = pending()
    const record = unsentAcceptance(item)
    expect(proposalState(item, EXPIRY - 1, [record]).button).toMatchObject({
      kind: 'open',
      action: 'accept',
      unsentTx: record,
      label: 'Broadcast again',
    })
  })

  it('only discards an unsent acceptance once the term has passed', () => {
    const item = pending()
    const record = unsentAcceptance(item)
    for (const tip of [EXPIRY, EXPIRY + 1]) {
      const state = proposalState(item, tip, [record])
      expect(state.button).toEqual({
        kind: 'discard',
        record,
        label: 'Discard',
        variant: 'secondary',
      })
      expect(state.note).toContain('can no longer be sent')
    }
  })

  it('offers nothing for an unsent acceptance while the tip is unknown', () => {
    const item = pending()
    const state = proposalState(item, 0, [unsentAcceptance(item)])
    expect(state.button).toBeNull()
    expect(state.note).toContain('Waiting for the chain tip.')
  })
})

const CLAIM_TXID = '12'.repeat(32)
const ACCEPT_TXID = '34'.repeat(32)

function utxo(type: string, txid: string, vout: number, spentTxid: string | null = null) {
  return {
    utxo_type: type,
    txid,
    vout,
    created_at_height: EXPIRY - 30 * 1440,
    spent_txid: spentTxid,
    spent_at_height: spentTxid === null ? null : EXPIRY - 29 * 1440,
  }
}

/** The borrower's own offer in `status`, with the UTXOs the indexer lists for it. */
function own(status: PrivateOfferStatus, utxos: ReturnType<typeof utxo>[]): OpenedOfferItem {
  const item = pending(status)
  return {
    ...item,
    role: 'borrower',
    candidate: { ...item.candidate, status, utxos } as unknown as PrivateCandidateDetails,
  }
}

const OPEN = [utxo('pending_offer', TXID, 3)]
/** Accepted: the pending offer spent, the principal waiting at its lock. */
const ACCEPTED = [
  utxo('pending_offer', TXID, 3, ACCEPT_TXID),
  utxo('active_offer', ACCEPT_TXID, 0),
  utxo('principal', ACCEPT_TXID, 1),
]
/** Accepted, and the borrower received the principal. */
const RECEIVED = [
  utxo('pending_offer', TXID, 3, ACCEPT_TXID),
  utxo('active_offer', ACCEPT_TXID, 0),
  utxo('principal', ACCEPT_TXID, 1, CLAIM_TXID),
]

const AMOUNTS = { receive: '1,000 TEST', repay: '1,100.00 TEST' }

/** My loans' state of `item` at `tip`, with `txs` saved in this browser. */
function loanState(item: OpenedOfferItem, tip: number, txs: PrivateTxRecord[] = []) {
  return offerActionState(txs, item, borrowerActions(AMOUNTS), opened => borrowerView(opened, tip))
}

describe("the borrower's loans", () => {
  it('waits for the lender, with Cancel, while the proposal can be accepted', () => {
    const item = own('pending', OPEN)
    expect(borrowerStatus(item, EXPIRY - 1)).toEqual({ kind: 'waiting' })
    expect(borrowerStatus(item, 0)).toEqual({ kind: 'waiting' })
    expect(loanState(item, EXPIRY - 1).button).toMatchObject({
      kind: 'open',
      action: 'cancel',
      label: 'Cancel',
      variant: 'danger-soft',
    })
  })

  it('says a proposal was not accepted in time, and still cancels it', () => {
    const item = own('pending', OPEN)
    expect(borrowerStatus(item, EXPIRY)).toEqual({ kind: 'notAccepted' })
    const state = loanState(item, EXPIRY + 1)
    expect(state.button).toMatchObject({ action: 'cancel', label: 'Cancel' })
    expect(state.note).toContain('Cancel it to take your collateral back')
  })

  it('receives the principal once the lender accepted', () => {
    const item = own('active', ACCEPTED)
    expect(borrowerStatus(item, EXPIRY - 1)).toEqual({ kind: 'accepted' })
    expect(loanState(item, EXPIRY - 1).button).toMatchObject({
      action: 'claimPrincipal',
      label: 'Receive 1,000 TEST',
      variant: 'primary',
    })
  })

  it('repays an active loan once the principal was received, with the days left', () => {
    const item = own('active', RECEIVED)
    expect(borrowerStatus(item, EXPIRY - 12 * 1440)).toEqual({
      kind: 'active',
      blocksLeft: 12 * 1440,
    })
    expect(borrowerStatus(item, 0)).toEqual({ kind: 'active', blocksLeft: null })
    expect(loanState(item, EXPIRY - 1).button).toMatchObject({
      action: 'repay',
      label: 'Repay 1,100.00 TEST',
    })
    expect(loanState(item, EXPIRY + 1).note).toContain('may take your collateral')
  })

  it('never repays without evidence that the principal was received', () => {
    // The indexer omits the principal: no claim is known, and a repayment would burn its key.
    const item = own('active', ACCEPTED.slice(0, 2))
    const state = loanState(item, EXPIRY - 1)
    expect(state.button).toBeNull()
    expect(state.note).toContain('cannot be repaid yet')
  })

  it('names how each loan ended', () => {
    expect(borrowerStatus(own('repaid', []), EXPIRY)).toEqual({ kind: 'repaid' })
    expect(borrowerStatus(own('cancelled', []), EXPIRY)).toEqual({ kind: 'cancelled' })
    expect(borrowerStatus(own('liquidated', RECEIVED), EXPIRY)).toEqual({
      kind: 'collateralTaken',
    })
  })

  it('still receives the principal of a loan whose collateral was taken', () => {
    const state = loanState(own('liquidated', ACCEPTED), EXPIRY + 1)
    expect(state.button).toMatchObject({ action: 'claimPrincipal', label: 'Receive 1,000 TEST' })
  })

  it('broadcasts an unsent transaction again, whatever the tip', () => {
    const item = own('pending', OPEN)
    const record = unsent(item, 'private_cancel_offer')
    for (const tip of [0, EXPIRY + 1]) {
      expect(loanState(item, tip, [record]).button).toMatchObject({
        kind: 'open',
        action: 'cancel',
        unsentTx: record,
        label: 'Broadcast again',
      })
    }
  })

  it('offers nothing while its transaction waits for confirmation', () => {
    const item = own('active', ACCEPTED)
    const record = { ...unsent(item, 'private_claim_principal'), broadcastStatus: 'broadcast' }
    const state = loanState(item, EXPIRY - 1, [record as PrivateTxRecord])
    expect(state.isProcessing).toBe(true)
    expect(state.button).toBeNull()
  })

  it('writes when a loan is due', () => {
    expect(dueText(12 * 1440)).toBe('due in 12 days')
    expect(dueText(90)).toBe('due in 1 h')
    expect(dueText(0)).toBe('due now')
    expect(dueText(-2 * 1440)).toBe('overdue by 2 days')
  })
})

const INSTALLMENT_TXID = '56'.repeat(32)
const SECOND_INSTALLMENT_TXID = '78'.repeat(32)
const INSTALLMENT_CLAIM_TXID = '9a'.repeat(32)
const CLOSE_TXID = 'bc'.repeat(32)
const FINAL_CLAIM_TXID = 'de'.repeat(32)
const INSTALLMENT = `${INSTALLMENT_TXID}:2`

/** Received, then an installment: the loan moved to its output 1, the installment at output 2. */
const PAID_ONCE = [
  utxo('pending_offer', TXID, 3, ACCEPT_TXID),
  utxo('active_offer', ACCEPT_TXID, 0, INSTALLMENT_TXID),
  utxo('principal', ACCEPT_TXID, 1, CLAIM_TXID),
  utxo('active_offer', INSTALLMENT_TXID, 1),
  utxo('installment', INSTALLMENT_TXID, 2),
]

/** The loan's figures after `installments`, as `useLoan` reads them. */
function figures(
  installments: { outpoint: string; amount: bigint | undefined }[],
  remaining: bigint | undefined,
  loanOutpoint = `${INSTALLMENT_TXID}:1`,
): LoanFigures {
  return {
    loanOutpoint,
    installments,
    paid: installments.reduce((sum, { amount }) => sum + (amount ?? 0n), 0n),
    remaining,
  }
}

/** My loans' state of `item` at `tip` with its loan's figures, as the page computes it. */
function paidLoanState(
  item: OpenedOfferItem,
  tip: number,
  loan: LoanFigures | undefined,
  txs: PrivateTxRecord[] = [],
) {
  return offerActionState(
    txs,
    item,
    borrowerActions(AMOUNTS),
    opened => borrowerView(opened, tip, loan),
    borrowerSendable(tip),
  )
}

describe("the borrower's installments", () => {
  it('shows what was repaid of the repayment, and repays the rest', () => {
    const item = own('active', PAID_ONCE)
    const loan = figures([{ outpoint: INSTALLMENT, amount: 30_000n }], 80_000n)
    expect(borrowerStatus(item, EXPIRY - 12 * 1440, loan)).toEqual({
      kind: 'active',
      blocksLeft: 12 * 1440,
      paid: 30_000n,
    })
    expect(paidLoanState(item, EXPIRY - 1, loan).button).toMatchObject({
      kind: 'open',
      action: 'repay',
    })
  })

  // The note and the repay form share one boundary: from the expiry block on, the form refuses an
  // installment, and the note says why.
  it('says the term has ended from the expiry block on, as the form refuses an installment', () => {
    const item = own('active', PAID_ONCE)
    const loan = figures([{ outpoint: INSTALLMENT, amount: 30_000n }], 80_000n)
    const ended = 'The term has ended: the lender may take your collateral at any time.'
    for (const tip of [EXPIRY, EXPIRY + 1]) {
      expect(borrowerView(item, tip, loan)).toEqual({ action: 'repay', note: ended })
    }
    // before it, and while the tip is unknown, nothing
    for (const tip of [EXPIRY - 1, 0]) {
      expect(borrowerView(item, tip, loan)).toEqual({ action: 'repay' })
    }
  })

  it('closes the loan once the installments paid the whole debt', () => {
    const item = own('active', PAID_ONCE)
    const loan = figures([{ outpoint: INSTALLMENT, amount: 110_000n }], 0n)
    const view = borrowerView(item, EXPIRY - 1, loan)
    expect(view.action).toBe('closeZeroDebt')
    expect(borrowerActions(AMOUNTS).labels.closeZeroDebt).toBe('Close the loan')
    expect(paidLoanState(item, EXPIRY - 1, loan).button).toMatchObject({
      kind: 'open',
      action: 'closeZeroDebt',
      label: 'Close the loan',
    })
    // past the term too: the close takes the collateral back
    expect(borrowerView(item, EXPIRY + 1, loan).action).toBe('closeZeroDebt')
  })

  it('offers no repayment while what is owed cannot be read', () => {
    const item = own('active', PAID_ONCE)
    const loan = figures([{ outpoint: INSTALLMENT, amount: undefined }], undefined)
    const state = paidLoanState(item, EXPIRY - 1, loan)
    expect(state.button).toBeNull()
    expect(state.note).toContain('does not open with your key')
  })

  // Review focus 5: a retried installment is broadcast again as saved, or discarded; never built
  // a second time, which could reuse its range proof's nonce.
  it('gives an unsent installment only "Broadcast again", or "Discard" once the term ended', () => {
    const item = own('active', PAID_ONCE)
    const loan = figures([{ outpoint: INSTALLMENT, amount: 30_000n }], 80_000n)
    const record = unsent(item, 'private_installment')
    for (const tip of [EXPIRY - 1440, EXPIRY - 1]) {
      expect(paidLoanState(item, tip, loan, [record]).button).toEqual({
        kind: 'open',
        action: 'repay',
        item,
        unsentTx: record,
        label: 'Broadcast again',
        variant: 'secondary',
      })
    }
    // at the expiry the lender can liquidate and keep it: it is no longer sent
    for (const tip of [EXPIRY, EXPIRY + 1]) {
      const state = paidLoanState(item, tip, loan, [record])
      expect(state.button).toEqual({
        kind: 'discard',
        record,
        label: 'Discard',
        variant: 'secondary',
      })
      expect(state.note).toContain('can no longer be sent')
    }
    // while the tip is unknown, neither
    expect(paidLoanState(item, 0, loan, [record]).button).toBeNull()
    // a zero-debt state does not lift the block either
    const paidOff = figures([{ outpoint: INSTALLMENT, amount: 110_000n }], 0n)
    expect(paidLoanState(item, EXPIRY - 1, paidOff, [record]).button).toMatchObject({
      kind: 'open',
      action: 'repay',
      unsentTx: record,
    })
  })

  it('broadcasts an unsent zero-debt close again', () => {
    const item = own('active', PAID_ONCE)
    const loan = figures([{ outpoint: INSTALLMENT, amount: 110_000n }], 0n)
    const record = unsent(item, 'private_zero_debt_close')
    expect(paidLoanState(item, EXPIRY + 1, loan, [record]).button).toMatchObject({
      kind: 'open',
      action: 'closeZeroDebt',
      unsentTx: record,
      label: 'Broadcast again',
    })
  })
})

const LOAN_ACTIONS: OfferActions<
  LenderAction,
  'private_claim_installments' | 'private_claim_repayment' | 'private_liquidate_offer'
> = {
  labels: LENDER_ACTION_LABELS,
  danger: 'liquidate',
  actionOfKind: {
    private_claim_installments: 'claimInstallments',
    private_claim_repayment: 'claimRepayment',
    private_liquidate_offer: 'liquidate',
  },
}

/** The lender's side of `own(status, utxos)`. */
function lent(status: PrivateOfferStatus, utxos: ReturnType<typeof utxo>[]): OpenedOfferItem {
  return { ...own(status, utxos), role: 'lender' }
}

/** The loan book's state of `item` at `tip` with its loan's figures. */
function bookState(item: OpenedOfferItem, tip: number, loan?: LoanFigures) {
  return offerActionState(
    [],
    item,
    LOAN_ACTIONS,
    opened => lenderView(opened, tip, loan),
    lenderSendable(tip),
  )
}

describe("the lender's installments and claims", () => {
  it('claims an unclaimed installment that opens', () => {
    const item = lent('active', PAID_ONCE)
    const loan = figures([{ outpoint: INSTALLMENT, amount: 30_000n }], 80_000n)
    expect(lenderView(item, EXPIRY - 1, loan).action).toBe('claimInstallments')
    expect(bookState(item, EXPIRY - 1, loan).button).toMatchObject({
      kind: 'open',
      action: 'claimInstallments',
      label: 'Claim',
      variant: 'primary',
    })
  })

  it('claims no installment that does not open, is claimed already, or is not read yet', () => {
    const unopened = figures([{ outpoint: INSTALLMENT, amount: undefined }], undefined)
    expect(lenderView(lent('active', PAID_ONCE), EXPIRY - 1, unopened).action).toBeUndefined()
    expect(lenderView(lent('active', PAID_ONCE), EXPIRY - 1, undefined).action).toBeUndefined()
    const claimed = PAID_ONCE.map(entry =>
      entry.utxo_type === 'installment'
        ? utxo('installment', INSTALLMENT_TXID, 2, INSTALLMENT_CLAIM_TXID)
        : entry,
    )
    const loan = figures([{ outpoint: INSTALLMENT, amount: 30_000n }], 80_000n)
    expect(lenderView(lent('active', claimed), EXPIRY - 1, loan)).toEqual({
      note: `Liquidation opens after block #${EXPIRY}.`,
    })
  })

  it('liquidates past the expiry, which sweeps the installments, rather than claiming them', () => {
    const loan = figures([{ outpoint: INSTALLMENT, amount: 30_000n }], 80_000n)
    expect(bookState(lent('active', PAID_ONCE), EXPIRY + 1, loan).button).toMatchObject({
      action: 'liquidate',
      label: 'Liquidate',
      variant: 'danger-soft',
    })
  })

  // Decision 2: the sweep after a full repayment and after a zero-debt close, and `claimed` once
  // it ran.
  it('claims the repayment after a full repayment, then shows the loan claimed', () => {
    const closed = [
      ...PAID_ONCE.slice(0, 3),
      utxo('active_offer', INSTALLMENT_TXID, 1, CLOSE_TXID),
      utxo('installment', INSTALLMENT_TXID, 2),
      utxo('repayment', CLOSE_TXID, 1),
    ]
    const repaid = lent('repaid', closed)
    expect(displayStatus(repaid.candidate)).toBe('repaid')
    expect(bookState(repaid, EXPIRY + 1).button).toMatchObject({
      action: 'claimRepayment',
      label: 'Claim repayment',
    })
    const swept = closed.map(entry =>
      entry.utxo_type === 'installment' || entry.utxo_type === 'repayment'
        ? utxo(entry.utxo_type, entry.txid, entry.vout, FINAL_CLAIM_TXID)
        : entry,
    )
    const claimed = lent('repaid', swept)
    expect(displayStatus(claimed.candidate)).toBe('claimed')
    expect(bookState(claimed, EXPIRY + 1).button).toBeNull()
  })

  it('claims the installments after a zero-debt close, then shows the loan claimed', () => {
    // two installments paid the debt; the lender claimed the first; the close left no repayment
    const closed = [
      ...PAID_ONCE.slice(0, 3),
      utxo('active_offer', INSTALLMENT_TXID, 1, SECOND_INSTALLMENT_TXID),
      utxo('installment', INSTALLMENT_TXID, 2, INSTALLMENT_CLAIM_TXID),
      utxo('active_offer', SECOND_INSTALLMENT_TXID, 1, CLOSE_TXID),
      utxo('installment', SECOND_INSTALLMENT_TXID, 2),
    ]
    const repaid = lent('repaid', closed)
    expect(displayStatus(repaid.candidate)).toBe('repaid')
    expect(bookState(repaid, EXPIRY - 1).button).toMatchObject({
      action: 'claimRepayment',
      label: 'Claim repayment',
    })
    const swept = closed.map(entry =>
      entry.utxo_type === 'installment' && entry.spent_txid === null
        ? utxo('installment', entry.txid, entry.vout, FINAL_CLAIM_TXID)
        : entry,
    )
    const claimed = lent('repaid', swept)
    expect(displayStatus(claimed.candidate)).toBe('claimed')
    expect(bookState(claimed, EXPIRY - 1).button).toBeNull()
    expect(borrowerStatus(own('repaid', swept), EXPIRY - 1)).toEqual({ kind: 'repaid' })
  })

  it('broadcasts an unsent installment claim again', () => {
    const item = lent('active', PAID_ONCE)
    const record = unsent(item, 'private_claim_installments')
    const state = offerActionState([record], item, LOAN_ACTIONS, opened =>
      lenderView(opened, EXPIRY - 1),
    )
    expect(state.button).toMatchObject({
      action: 'claimInstallments',
      unsentTx: record,
      label: 'Broadcast again',
    })
  })
})

describe("the borrower's saved creation", () => {
  const tip = 2_000_000
  const termDays = 30
  const term = { loanExpirationTime: proposalExpiry(tip, termDays), termDays }

  it('is sent while a confirmation in the next block counts the days chosen', () => {
    expect(creationSendable(term, tip)).toBe('yes')
    // The last tip whose next block is within the margin.
    expect(creationSendable(term, tip + TERM_MARGIN_BLOCKS - 1)).toBe('yes')
    expect(() => checkCreationSendable(term, tip + TERM_MARGIN_BLOCKS - 1)).not.toThrow()
  })

  it('is refused once it would count a day less, and past its expiry', () => {
    expect(creationSendable(term, tip + TERM_MARGIN_BLOCKS)).toBe('expired')
    expect(creationSendable(term, term.loanExpirationTime + 1)).toBe('expired')
    expect(() => checkCreationSendable(term, tip + TERM_MARGIN_BLOCKS)).toThrow(
      'Not sent. The chain moved on since it was signed: sent now, it would run fewer days than ' +
        'you chose. Discard it and propose again.',
    )
  })

  it('is refused without its term, which cannot be checked', () => {
    expect(creationSendable(undefined, tip)).toBe('expired')
    expect(creationExpiredNote(undefined)).toBe(
      'It was saved without its term, so it cannot be checked before it is sent.',
    )
    expect(() => checkCreationSendable(undefined, tip)).toThrow('saved without its term')
  })

  it('waits while the tip is unknown', () => {
    expect(creationSendable(term, 0)).toBe('unknown')
    expect(() => checkCreationSendable(term, 0)).toThrow('The chain tip is not known')
  })
})
