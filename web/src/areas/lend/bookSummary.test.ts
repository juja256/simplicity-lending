import { describe, expect, it } from 'vitest'

import type { PrivateCandidateDetails, PrivateOfferStatus } from '@/api/indexer/private'
import type { LoanFigures } from '@/privateLending/hooks/useLoan'
import { BLOCKS_PER_DAY } from '@/privateLending/lenderTerms'
import type { OpenedOfferItem } from '@/privateLending/offerView'

import { bookSummary, loanBookFigures } from './bookSummary'

const TIP = 3_000_000
let nextTxid = 0

/** An opened lender item with `status`, its expiry `blocksLeft` after the tip. */
function item(
  status: PrivateOfferStatus,
  blocksLeft: number,
  amounts: { principal: bigint; collateral: bigint },
  repaymentSpent = false,
): OpenedOfferItem {
  const txid = (nextTxid++).toString(16).padStart(64, '0')
  const candidate = {
    creation_txid: txid,
    status,
    created_at_height: TIP - 10 * BLOCKS_PER_DAY,
    updated_at_height: TIP - 10 * BLOCKS_PER_DAY,
    utxos:
      status === 'repaid'
        ? [
            {
              utxo_type: 'repayment',
              txid,
              vout: 0,
              created_at_height: TIP - BLOCKS_PER_DAY,
              spent_txid: repaymentSpent ? txid : null,
              spent_at_height: repaymentSpent ? TIP : null,
            },
          ]
        : [],
  } as unknown as PrivateCandidateDetails
  return {
    txid,
    role: 'lender',
    result: 'verified',
    candidate,
    terms: {
      borrowerPublicKey: 'b'.repeat(64),
      borrowerFingerprint: 'b'.repeat(16),
      lenderPublicKey: 'a'.repeat(64),
      lenderFingerprint: 'a'.repeat(16),
      collateralAsset: 'c'.repeat(64),
      collateralAmount: amounts.collateral,
      principalAsset: 'd'.repeat(64),
      principalAmount: amounts.principal,
      repaymentAmount: amounts.principal + 1n,
      interest: 1n,
      loanExpirationTime: TIP + blocksLeft,
      borrowerNft: 'e'.repeat(64),
      lenderNft: 'f'.repeat(64),
    },
  }
}

const NO_LOAN: LoanFigures = {
  loanOutpoint: `${'0a'.repeat(32)}:1`,
  installments: [],
  paid: 0n,
  remaining: undefined,
}

const amounts = (principal: bigint, collateral: bigint) => ({ principal, collateral })

const BOOK = [
  item('pending', 30 * BLOCKS_PER_DAY, amounts(1_000n, 10n)),
  item('pending', 60 * BLOCKS_PER_DAY, amounts(2_000n, 20n)),
  // Past its expiry: it can no longer be accepted, so it waits for no one.
  item('pending', -BLOCKS_PER_DAY, amounts(4_000n, 40n)),
  item('active', 3 * BLOCKS_PER_DAY, amounts(100n, 1n)),
  item('active', 8 * BLOCKS_PER_DAY, amounts(200n, 2n)),
  item('active', 7 * BLOCKS_PER_DAY, amounts(400n, 4n)),
  item('active', -5, amounts(800n, 8n)),
  item('repaid', -BLOCKS_PER_DAY, amounts(1_600n, 16n)),
  item('repaid', -BLOCKS_PER_DAY, amounts(3_200n, 32n), true),
  item('cancelled', 30 * BLOCKS_PER_DAY, amounts(6_400n, 64n)),
  item('liquidated', -BLOCKS_PER_DAY, amounts(12_800n, 128n)),
]

describe('bookSummary', () => {
  it('counts the proposals waiting, and sums and dates the active loans', () => {
    expect(bookSummary(BOOK, TIP)).toEqual({
      waiting: 2,
      active: 4,
      lent: 1_500n,
      // no loan was read: each counts at its offer's collateral, the most it can hold
      collateralHeld: 15n,
      collateralHeldExact: false,
      // Due in 3 days and in exactly 7 days; not in 8 days, not the overdue one.
      dueWithin7Days: 2,
      overdue: 1,
      // no loan was read
      repaid: 0n,
      claimable: 0n,
    })
  })

  it("counts the collateral an active loan holds after its releases, not the offer's", () => {
    const loan = item('active', 3 * BLOCKS_PER_DAY, amounts(100n, 10n))
    const figures: LoanFigures = { ...NO_LOAN, collateral: 4n }
    expect(bookSummary([loan], TIP, new Map([[loan.txid, figures]]))).toMatchObject({
      collateralHeld: 4n,
      collateralHeldExact: true,
    })
    // a loan whose collateral is not known (a search not run) is counted at its most, the offer's
    expect(bookSummary([loan], TIP, new Map([[loan.txid, NO_LOAN]]))).toMatchObject({
      collateralHeld: 10n,
      collateralHeldExact: false,
    })
  })

  it("counts the collateral the lender's search found, and at most the offer's until then", () => {
    const [first, second] = [3, 4].map(days =>
      item('active', days * BLOCKS_PER_DAY, amounts(100n, 10n)),
    )
    const read = new Map([
      [first.txid, NO_LOAN],
      [second.txid, NO_LOAN],
    ])
    // the first loan's search answered, the second's still runs
    expect(bookSummary([first, second], TIP, read, new Map([[first.txid, 6n]]))).toMatchObject({
      collateralHeld: 16n,
      collateralHeldExact: false,
    })
    expect(
      bookSummary(
        [first, second],
        TIP,
        read,
        new Map([
          [first.txid, 6n],
          [second.txid, 7n],
        ]),
      ),
    ).toMatchObject({ collateralHeld: 13n, collateralHeldExact: true })
    // a figure outside [1, C] cannot be the loan's
    for (const wrong of [0n, 11n]) {
      expect(bookSummary([first], TIP, read, new Map([[first.txid, wrong]]))).toMatchObject({
        collateralHeld: 10n,
        collateralHeldExact: false,
      })
    }
  })

  it('no longer counts a proposal waiting at its expiry block', () => {
    const atExpiry = item('pending', 0, amounts(1n, 1n))
    const blockBefore = item('pending', 1, amounts(1n, 1n))
    expect(bookSummary([atExpiry, blockBefore], TIP).waiting).toBe(1)
  })

  it('counts a loan at its expiry block as neither due nor overdue', () => {
    expect(bookSummary([item('active', 0, amounts(1n, 1n))], TIP)).toMatchObject({
      active: 1,
      dueWithin7Days: 0,
      overdue: 0,
    })
  })

  it('dates nothing while the tip is unknown', () => {
    expect(bookSummary(BOOK, 0)).toEqual({
      waiting: 3,
      active: 4,
      lent: 1_500n,
      collateralHeld: 15n,
      collateralHeldExact: false,
      dueWithin7Days: 0,
      overdue: 0,
      repaid: 0n,
      claimable: 0n,
    })
  })

  it('is all zeros for an empty book', () => {
    expect(bookSummary([], TIP)).toEqual({
      waiting: 0,
      active: 0,
      lent: 0n,
      collateralHeld: 0n,
      collateralHeldExact: true,
      dueWithin7Days: 0,
      overdue: 0,
      repaid: 0n,
      claimable: 0n,
    })
  })
})

const ACCEPT = '0a'.repeat(32)
const FIRST = '1a'.repeat(32)
const SECOND = '2a'.repeat(32)
const CLAIM = '3a'.repeat(32)
const CLOSE = '4a'.repeat(32)
const SWEEP = '5a'.repeat(32)

function utxo(type: string, txid: string, vout: number, spentTxid: string | null = null) {
  return {
    utxo_type: type,
    txid,
    vout,
    created_at_height: TIP - BLOCKS_PER_DAY,
    spent_txid: spentTxid,
    spent_at_height: spentTxid === null ? null : TIP,
  }
}

/** A loan of 1,000 lent for a repayment of 1,001, in `status`, with the UTXOs the indexer lists. */
function loanItem(status: PrivateOfferStatus, utxos: ReturnType<typeof utxo>[]): OpenedOfferItem {
  const base = item(status, 10 * BLOCKS_PER_DAY, amounts(1_000n, 10n))
  return {
    ...base,
    candidate: { ...base.candidate, utxos } as unknown as PrivateCandidateDetails,
  }
}

/** Two installments: the loan at the second's output 1, the first claimed by the lender. */
const TWO_PAID = [
  utxo('active_offer', ACCEPT, 0, FIRST),
  utxo('active_offer', FIRST, 1, SECOND),
  utxo('installment', FIRST, 2, CLAIM),
  utxo('active_offer', SECOND, 1),
  utxo('installment', SECOND, 2),
]

function figures(amounts: (bigint | undefined)[], remaining: bigint | undefined): LoanFigures {
  return {
    loanOutpoint: `${SECOND}:1`,
    installments: [FIRST, SECOND]
      .slice(0, amounts.length)
      .map((txid, j) => ({ outpoint: `${txid}:2`, amount: amounts[j] })),
    paid: amounts.reduce<bigint>((sum, amount) => sum + (amount ?? 0n), 0n),
    remaining,
  }
}

describe('loanBookFigures', () => {
  it('reads what was repaid, what remains and what is claimable of an active loan', () => {
    expect(loanBookFigures(loanItem('active', TWO_PAID), figures([300n, 200n], 501n))).toEqual({
      repaid: 500n,
      remaining: { amount: 501n, exact: true },
      // the first installment was claimed
      claimable: 200n,
      unknownClaimable: 0,
    })
  })

  it('bounds what remains, and leaves out the amount, of an installment that does not open', () => {
    expect(
      loanBookFigures(loanItem('active', TWO_PAID), figures([300n, undefined], undefined)),
    ).toEqual({
      repaid: 300n,
      // at most the repayment less what opened
      remaining: { amount: 701n, exact: false },
      claimable: 0n,
      unknownClaimable: 1,
    })
  })

  it('claims the rest of the repayment once the loan closed, whatever opened', () => {
    const closed = [
      ...TWO_PAID.slice(0, 3),
      utxo('active_offer', SECOND, 1, CLOSE),
      utxo('installment', SECOND, 2),
      utxo('repayment', CLOSE, 1),
    ]
    // the final claim sweeps the second installment and the repayment: 1,001 less the 300 claimed
    for (const loan of [figures([300n, 200n], 501n), figures([300n, undefined], undefined)]) {
      expect(loanBookFigures(loanItem('repaid', closed), loan)).toEqual({
        repaid: 1_001n,
        remaining: { amount: 0n, exact: true },
        claimable: 701n,
        unknownClaimable: 0,
      })
    }
    const swept = closed.map(entry =>
      entry.spent_txid === null && entry.utxo_type !== 'active_offer'
        ? utxo(entry.utxo_type, entry.txid, entry.vout, SWEEP)
        : entry,
    )
    expect(loanBookFigures(loanItem('repaid', swept), figures([300n, 200n], 501n))).toEqual({
      repaid: 1_001n,
      remaining: { amount: 0n, exact: true },
      claimable: 0n,
      unknownClaimable: 0,
    })
  })

  it('reads nothing before the loan is read', () => {
    expect(loanBookFigures(loanItem('active', TWO_PAID), undefined)).toBeNull()
  })
})

describe("bookSummary's repaid and claimable", () => {
  it('sums the loans read', () => {
    const active = loanItem('active', TWO_PAID)
    const unopened = loanItem('active', TWO_PAID)
    const unread = loanItem('active', TWO_PAID)
    const loans = new Map([
      [active.txid, figures([300n, 200n], 501n)],
      [unopened.txid, figures([300n, undefined], undefined)],
    ])
    expect(bookSummary([active, unopened, unread], TIP, loans)).toMatchObject({
      active: 3,
      repaid: 800n,
      claimable: 200n,
    })
  })
})
