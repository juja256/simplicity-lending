import { describe, expect, it } from 'vitest'

import type { PrivateCandidateDetails, PrivateOfferStatus } from '@/api/indexer/private'
import { BLOCKS_PER_DAY } from '@/privateLending/lenderTerms'
import type { OpenedOfferItem } from '@/privateLending/offerView'

import { bookSummary } from './bookSummary'

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
      collateralHeld: 15n,
      // Due in 3 days and in exactly 7 days; not in 8 days, not the overdue one.
      dueWithin7Days: 2,
      overdue: 1,
    })
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
      dueWithin7Days: 0,
      overdue: 0,
    })
  })

  it('is all zeros for an empty book', () => {
    expect(bookSummary([], TIP)).toEqual({
      waiting: 0,
      active: 0,
      lent: 0n,
      collateralHeld: 0n,
      dueWithin7Days: 0,
      overdue: 0,
    })
  })
})
