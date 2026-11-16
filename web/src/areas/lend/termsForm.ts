// What the console's Terms page opens with. Pure, so tests import it: it takes only types from
// the directory hook.
import type { OwnEntry } from '@/privateLending/hooks/useDirectory'
import {
  EMPTY_PAIR_TERMS_FORM,
  findPairTerms,
  type LenderTermsInput,
  type PairTermsForm,
  pairTermsToForm,
  type TermsPair,
} from '@/privateLending/lenderTerms'

/**
 * The terms the wallet's own key signed: its entry's terms when the entry verified, null when it
 * has no entry or the entry did not verify (unsigned or invalid). Never the terms as served.
 */
export function verifiedOwnTerms(own: OwnEntry): LenderTermsInput | null {
  return own.entry !== null && own.check?.status === 'verified' ? own.check.terms : null
}

/**
 * The terms form as it opens: the own entry's terms for `pair` when the entry verified against
 * the key, and empty otherwise. Nothing the indexer serves pre-fills it unless the key signed it.
 */
export function termsFormOf(own: OwnEntry, pair: TermsPair): PairTermsForm {
  const published = findPairTerms(verifiedOwnTerms(own), pair)
  return published ? pairTermsToForm(published, pair) : EMPTY_PAIR_TERMS_FORM
}
