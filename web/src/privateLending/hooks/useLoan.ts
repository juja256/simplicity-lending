// The loan of an opened offer, for display: read on chain by `loadLoan` from the loan output the
// indexer lists, for either party, and kept as plain figures. The figures only decide what a page
// shows and offers: every build loads its loan fresh through the gate, and the loan's state, which
// holds its blinders, is freed once read. A loan output's history never changes, so a loan is read
// once per loan output and session; a new installment or a close moves the loan to another one. A
// read that failed is tried again every 30 seconds, as a transient esplora error must not hide the
// loan's actions for good. The same read copies out the messages of the acceptance and the
// installments (`loanChainMessages`), which the loan's timeline shows; a message that does not
// read never fails the loan.
import { useQueries, useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { useCallback } from 'react'

import { latestLoanUtxo, utxoOutpoint } from '@/privateLending/candidate'
import type { CollateralSearchInput } from '@/privateLending/flows/liquidation'
import { loadLoan, type Loan } from '@/privateLending/loan'
import { type LoanChainMessages, loanChainMessages } from '@/privateLending/loanMessages'
import { openedOffersOf } from '@/privateLending/offerCache'
import type { OpenedOfferItem } from '@/privateLending/offerView'
import { withVerifiedOffer } from '@/privateLending/scan'
import { useLwk } from '@/providers/lwk/useLwk'
import { useWallet } from '@/providers/wallet/useWallet'

import { privateLoanQueryKey } from './queryKeys'
import { PRIVATE_API_BASE_URL, usePrivateFlowDeps } from './usePrivateFlowDeps'

/** How often a loan read that failed is tried again. */
const LOAN_RETRY_MS = 30_000

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
  /**
   * The collateral the loan output holds, `c_k`, when the party can compute it: always for the
   * borrower, and for the lender while every installment opens. Undefined otherwise: the lender
   * finds it by `collateralSearch`.
   */
  collateral?: bigint | undefined
  /**
   * What the lender's search for `c_k` takes, when `collateral` is unknown: plain values, with the
   * step's blinder, a secret of the offer that stays in this browser.
   */
  collateralSearch?: CollateralSearchInput | undefined
}

/** What `useLoan` reads of a loan: its figures, and the messages of its transactions. */
export interface LoanWithMessages extends LoanFigures {
  messages: LoanChainMessages
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
  const collateral = state.collateral()?.amount
  return {
    loanOutpoint: state.loanOutpoint,
    installments,
    paid: state.paid,
    remaining: state.remaining,
    collateral,
    collateralSearch: collateral === undefined ? searchInputOf(state) : undefined,
  }
}

/** What the search for the collateral takes, as plain values; undefined if the state gives none. */
function searchInputOf(state: Loan['state']): CollateralSearchInput | undefined {
  try {
    const search = state.collateralSearch()
    const input = {
      valueCommitment: search.valueCommitment,
      assetCommitment: search.assetCommitment,
      blinder: search.blinder,
      max: search.max,
    }
    search.free()
    return input
  } catch {
    return undefined
  }
}

/** The query of an item's loan, the same for `useLoan` and `useLoans`. */
function useLoanQuery(): (item: OpenedOfferItem) => UseQueryOptions<LoanWithMessages> {
  const { network } = useLwk()
  const { isReady, privateCapable, scriptPubkey, getLendingKey } = useWallet()
  const getDeps = usePrivateFlowDeps()

  return useCallback(
    (item: OpenedOfferItem): UseQueryOptions<LoanWithMessages> => {
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
        retry: 1,
        // Only while in error: a loan output that does not lead back to the acceptance is read
        // again then too, and refused again.
        refetchInterval: query => (query.state.status === 'error' ? LOAN_RETRY_MS : false),
        queryFn: async () => {
          const [deps, key] = await Promise.all([getDeps(), getLendingKey()])
          const { txid, role } = item
          // The session's cache owns the opened offer, which stays for the next read.
          return withVerifiedOffer(
            openedOffersOf(key),
            deps,
            key,
            txid,
            role,
            PRIVATE_API_BASE_URL,
            async offer => {
              const loan = await loadLoan(deps, offer, key, loanOutpoint)
              try {
                const messages = loanChainMessages(deps.wasm, offer, key, role, loan)
                return { ...loanFigures(loan), messages }
              } finally {
                loan.state.free()
              }
            },
          )
        },
      }
    },
    [network, isReady, privateCapable, scriptPubkey, getDeps, getLendingKey],
  )
}

/**
 * The `Loan` of an opened offer, for either party, as its plain figures and messages: read by
 * `loadLoan` from the loan output the indexer lists (`latestLoanUtxo`), and keyed by it. Disabled
 * for an offer that was never accepted.
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
