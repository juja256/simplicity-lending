// The loan of an opened offer, for display: read on chain by `loadLoan` from the loan output the
// indexer lists, for either party, and kept as plain figures. The figures only decide what a page
// shows and offers: every build loads its loan fresh through the gate, and the loan's state, which
// holds its blinders, is freed once read. A loan output's history never changes, so a loan is read
// once per loan output and session; a new installment or a close moves the loan to another one.
import { useQueries, useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { useCallback } from 'react'

import { latestLoanUtxo, utxoOutpoint } from '@/privateLending/candidate'
import { loadLoan, type Loan } from '@/privateLending/loan'
import type { OpenedOfferItem } from '@/privateLending/offerView'
import { loadVerifiedOffer } from '@/privateLending/scan'
import { useLwk } from '@/providers/lwk/useLwk'
import { useWallet } from '@/providers/wallet/useWallet'

import { privateLoanQueryKey } from './queryKeys'
import { PRIVATE_API_BASE_URL, usePrivateFlowDeps } from './usePrivateFlowDeps'

/** A loan's figures for the party that opened its offer, as `loadLoan` read them. */
export interface LoanFigures {
  /** The loan output read, `"<txid>:<vout>"`: the one unspent now, or the last before the close. */
  loanOutpoint: string
  /** Each installment in chain order: its output 2, and its amount when it opened for the party. */
  installments: { outpoint: string; amount: bigint | undefined }[]
  /** The sum of the installments that opened for the party. */
  paid: bigint
  /** What the loan owes after them, when every one opened; undefined otherwise. */
  remaining: bigint | undefined
}

/** The figures of `loan`, read from its state, which the caller still frees. */
export function loanFigures(loan: Loan): LoanFigures {
  const { state } = loan
  const installments: LoanFigures['installments'] = []
  for (let j = 1; j <= state.installmentCount; j += 1) {
    const installment = state.installment(j)
    installments.push({ outpoint: installment.outpoint, amount: installment.amount })
    installment.free()
  }
  return {
    loanOutpoint: state.loanOutpoint,
    installments,
    paid: state.paid,
    remaining: state.remaining,
  }
}

/** The query of an item's loan, the same for `useLoan` and `useLoans`. */
function useLoanQuery(): (item: OpenedOfferItem) => UseQueryOptions<LoanFigures> {
  const { network } = useLwk()
  const { isReady, privateCapable, scriptPubkey, getLendingKey } = useWallet()
  const getDeps = usePrivateFlowDeps()

  return useCallback(
    (item: OpenedOfferItem): UseQueryOptions<LoanFigures> => {
      const utxo = latestLoanUtxo(item.candidate)
      const loanOutpoint = utxo ? utxoOutpoint(utxo) : ''
      return {
        queryKey: privateLoanQueryKey(
          network,
          PRIVATE_API_BASE_URL,
          scriptPubkey ?? '',
          item.txid,
          item.role,
          loanOutpoint,
        ),
        enabled: isReady && privateCapable && scriptPubkey !== null && loanOutpoint !== '',
        staleTime: Infinity,
        // a loan output that does not lead back to the acceptance stays refused
        retry: 1,
        queryFn: async () => {
          const [deps, key] = await Promise.all([getDeps(), getLendingKey()])
          const { txid, role } = item
          const offer = await loadVerifiedOffer(deps, key, txid, role, PRIVATE_API_BASE_URL)
          try {
            const loan = await loadLoan(deps, offer, key, loanOutpoint)
            try {
              return loanFigures(loan)
            } finally {
              loan.state.free()
            }
          } finally {
            offer.opened.free()
          }
        },
      }
    },
    [network, isReady, privateCapable, scriptPubkey, getDeps, getLendingKey],
  )
}

/**
 * The `Loan` of an opened offer, for either party, as its plain figures: read by `loadLoan` from
 * the loan output the indexer lists (`latestLoanUtxo`), and keyed by it. Disabled for an offer
 * that was never accepted.
 */
export function useLoan(item: OpenedOfferItem) {
  const query = useLoanQuery()
  return useQuery(query(item))
}

/** What `useLoans` read of a loan: its figures, or why they could not be read. */
export interface LoanRead {
  figures?: LoanFigures
  error?: Error
}

/** `useLoan` of each item, by creation txid. */
export function useLoans(items: readonly OpenedOfferItem[]): ReadonlyMap<string, LoanRead> {
  const query = useLoanQuery()
  const results = useQueries({ queries: items.map(item => query(item)) })
  return new Map(
    items.map((item, index) => [
      item.txid,
      { figures: results[index]?.data, error: results[index]?.error ?? undefined },
    ]),
  )
}
