import { describe, expect, it, vi } from 'vitest'

import type { PrivateCandidateDetails, PrivateOfferStatus } from '@/api/indexer/private'
import type { PrivateTxRecord } from '@/providers/pendingTransactions/types'

import type { PrivateOfferItem } from './hooks/usePrivateOffers'
import {
  canStillAccept,
  checkStillAcceptable,
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
  return {
    txid: 'cd'.repeat(32),
    kind: 'private_accept_offer',
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
