import { describe, expect, it } from 'vitest'

import type { DirectoryEntry } from '@/api/indexer/private'
import type { OwnEntry } from '@/privateLending/hooks/useDirectory'
import {
  EMPTY_PAIR_TERMS_FORM,
  type LenderTermsInput,
  type PairTermsInput,
  pairTermsToForm,
  type TermsPair,
} from '@/privateLending/lenderTerms'

import { termsFormOf, verifiedOwnTerms } from './termsForm'

const PAIR: TermsPair = {
  principal: { id: 'a0'.repeat(32), decimals: 8, symbol: 'TEST' },
  collateral: { id: 'b0'.repeat(32), decimals: 8, symbol: 'tL-BTC' },
}

const SIGNED: PairTermsInput = {
  principal_asset: PAIR.principal.id,
  collateral_asset: PAIR.collateral.id,
  min_apr_bps: 600,
  max_principal_per_collateral: '5000000000000',
  min_term_days: 30,
  max_term_days: 180,
  min_principal: '100000000000',
  max_principal: '5000000000000',
}

/** What an indexer could serve instead: a lower rate than the key signed. */
const SERVED: LenderTermsInput = { pairs: [{ ...SIGNED, min_apr_bps: 100 }] }

const ENTRY: DirectoryEntry = {
  pubkey: 'c0'.repeat(32),
  display_name: 'Lender',
  terms: SERVED,
  terms_published_at: 1_700_000_000,
  signed_challenge: 'd0'.repeat(32),
  signature: 'e0'.repeat(64),
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
}

describe("the profile's terms form", () => {
  it('opens on the terms the key signed when the entry verified', () => {
    const own: OwnEntry = {
      entry: ENTRY,
      check: { status: 'verified', terms: { pairs: [SIGNED] } },
    }
    expect(verifiedOwnTerms(own)).toEqual({ pairs: [SIGNED] })
    expect(termsFormOf(own, PAIR)).toEqual(pairTermsToForm(SIGNED, PAIR))
  })

  it('opens empty for an entry that did not verify, whatever terms it serves', () => {
    for (const status of ['unsigned', 'invalid'] as const) {
      const own: OwnEntry = { entry: ENTRY, check: { status } }
      expect(verifiedOwnTerms(own)).toBeNull()
      expect(termsFormOf(own, PAIR)).toEqual(EMPTY_PAIR_TERMS_FORM)
    }
  })

  it('opens empty without an entry, or without terms for the pair', () => {
    expect(termsFormOf({ entry: null, check: null }, PAIR)).toEqual(EMPTY_PAIR_TERMS_FORM)
    const otherPair = { ...SIGNED, collateral_asset: 'f0'.repeat(32) }
    const own: OwnEntry = {
      entry: ENTRY,
      check: { status: 'verified', terms: { pairs: [otherPair] } },
    }
    expect(termsFormOf(own, PAIR)).toEqual(EMPTY_PAIR_TERMS_FORM)
  })
})
