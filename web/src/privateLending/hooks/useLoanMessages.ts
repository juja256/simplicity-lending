// The private messages of an opened offer's loan, for its timeline (`collectLoanMessages`): the
// creation's from the signed terms, the acceptance's and the installments' as `useLoan` read them,
// and beside the loan the full repayment's and this wallet's records of what it sent. Every txid
// a message is matched by comes from the chain: the acceptance and the installments from the walk
// back from the loan output, the full repayment from the transaction that spends the loan's last
// output. The indexer only says where to look.
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import type { PrivateFlowDeps } from '@/privateLending/deps'
import {
  type ChainMessage,
  collectLoanMessages,
  copyMessage,
  type LoanMessage,
} from '@/privateLending/loanMessages'
import type { OpenedOfferItem } from '@/privateLending/offerView'
import { loadVerifiedOffer } from '@/privateLending/scan'
import type { SentMessage } from '@/privateLending/sentMessages'
import { useLwk } from '@/providers/lwk/useLwk'
import { useWallet } from '@/providers/wallet/useWallet'
import { REPAYMENT_INPUT, REPAYMENT_OUTPUT } from '@/simplicity/private-lending/layout'
import type { LendingKey } from '@/wasm/private-lending/private_lending_wasm'

import { privateLoanMessagesQueryKey } from './queryKeys'
import { useLoan } from './useLoan'
import { PRIVATE_API_BASE_URL, usePrivateFlowDeps } from './usePrivateFlowDeps'
import { openSentMessages } from './usePrivateOffers'

/** What `useLoanMessages` reads beside the loan. */
interface BesideLoan {
  /** This wallet's records for the offer. */
  sent: SentMessage[]
  /** The full repayment, when the loan closed with one that was read. */
  repayment?: ChainMessage
  /** Whether reading the full repayment failed: it is tried again. */
  repaymentFailed: boolean
}

/** How often a full repayment that could not be read is tried again. */
const REPAYMENT_RETRY_MS = 30_000

/**
 * The full repayment `repaymentTxid`, if it closes the loan output `loanOutpoint` (spends it at
 * input 1), with its message read for the lender, which also requires output 1 at the repayment
 * lock (a zero-debt close's is not). The borrower cannot read its own (its nonce is random), so
 * for the borrower it is only the txid its record is matched by: the zero-debt close records no
 * message. Undefined for a transaction that does not close this loan.
 */
async function readRepayment(
  deps: PrivateFlowDeps,
  key: LendingKey,
  item: OpenedOfferItem,
  loanOutpoint: string,
  repaymentTxid: string,
): Promise<ChainMessage | undefined> {
  const tx = await deps.fetchTx(repaymentTxid)
  const spent = tx.inputs[REPAYMENT_INPUT.offer]?.outpoint()
  if (spent === undefined || `${spent.txid().toString()}:${spent.vout()}` !== loanOutpoint) {
    return undefined
  }
  if (item.role === 'borrower') return { txid: repaymentTxid }
  const offer = await loadVerifiedOffer(deps, key, item.txid, item.role, PRIVATE_API_BASE_URL)
  try {
    const lock = tx.outputs[REPAYMENT_OUTPUT.repayment]?.scriptPubkey().jet_sha256_hex()
    if (lock !== offer.scripts.repaymentOutputScriptHash) return undefined
    const read = copyMessage(() =>
      offer.opened.readMessage(
        key,
        item.txid,
        tx.toString(),
        REPAYMENT_OUTPUT.repayment,
        deps.wasm.MessagePhase.FullRepayment,
      ),
    )
    return { txid: repaymentTxid, read }
  } finally {
    offer.opened.free()
  }
}

/**
 * The messages of `item`'s loan in chain order, for either party, and whether they are still being
 * read. An offer never accepted has at most the creation's.
 */
export function useLoanMessages(item: OpenedOfferItem): {
  messages: LoanMessage[]
  isLoading: boolean
} {
  const { network } = useLwk()
  const { isReady, privateCapable, scriptPubkey, getLendingKey } = useWallet()
  const getDeps = usePrivateFlowDeps()
  const loan = useLoan(item)
  const figures = loan.data
  const loanOutpoint = figures?.loanOutpoint
  // Spent or not: the lender's claim spends it, and its message stays.
  const repaymentTxid = item.candidate.utxos.find(utxo => utxo.utxo_type === 'repayment')?.txid

  const beside = useQuery({
    queryKey: privateLoanMessagesQueryKey(
      network,
      PRIVATE_API_BASE_URL,
      scriptPubkey ?? '',
      item.txid,
      item.role,
      loanOutpoint ?? '',
      repaymentTxid ?? '',
    ),
    enabled: isReady && privateCapable && scriptPubkey !== null && loanOutpoint !== undefined,
    staleTime: Infinity,
    retry: 1,
    // Only while the full repayment could not be read: the records show meanwhile.
    refetchInterval: query =>
      query.state.status === 'error' || query.state.data?.repaymentFailed === true
        ? REPAYMENT_RETRY_MS
        : false,
    queryFn: async (): Promise<BesideLoan> => {
      const [deps, key] = await Promise.all([getDeps(), getLendingKey()])
      const sent = (await openSentMessages(network, key))?.forOffer(item.txid) ?? []
      if (repaymentTxid === undefined || loanOutpoint === undefined) {
        return { sent, repaymentFailed: false }
      }
      try {
        const repayment = await readRepayment(deps, key, item, loanOutpoint, repaymentTxid)
        return { sent, repayment, repaymentFailed: false }
      } catch (error) {
        console.warn(`private offer ${item.txid}: the full repayment was not read`, error)
        return { sent, repaymentFailed: true }
      }
    },
  })

  const messages = useMemo(
    () =>
      collectLoanMessages({
        role: item.role,
        offerTxid: item.txid,
        creation: item.terms.message,
        acceptance: figures?.messages.acceptance,
        installments: figures?.messages.installments ?? [],
        repayment: beside.data?.repayment,
        sent: beside.data?.sent ?? [],
      }),
    [item, figures, beside.data],
  )
  return { messages, isLoading: loan.isLoading || beside.isLoading }
}
