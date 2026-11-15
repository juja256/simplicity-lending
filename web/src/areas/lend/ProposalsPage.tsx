import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import KeyFingerprint from '@/components/KeyFingerprint'
import AcceptPrivateOfferModal from '@/components/modals/private/AcceptPrivateOfferModal'
import Notice from '@/components/Notice'
import { UiButton } from '@/components/ui/UiButton'
import { NETWORK_CONFIG } from '@/constants/network-config'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { useKeyedModal } from '@/hooks/useKeyedModal'
import { privateLendingWasmQueryKey } from '@/privateLending/hooks/queryKeys'
import { type OwnEntry, useDirectory } from '@/privateLending/hooks/useDirectory'
import { usePrivateOffers } from '@/privateLending/hooks/usePrivateOffers'
import {
  BLOCKS_PER_DAY,
  formatAprBps,
  maxPrincipalPerCollateralToDisplay,
  termBlocksOf,
  type TermsPair,
} from '@/privateLending/lenderTerms'
import {
  isOpenedOffer,
  LENDER_ACTION_LABELS,
  type LenderAction,
  lenderSendable,
  lenderView,
  type OfferActions,
  type OfferActionState,
  offerActionState,
  type OpenedOfferItem,
} from '@/privateLending/offerView'
import {
  checkAgainstTerms,
  proposalOfOffer,
  type TermsVerdict,
} from '@/privateLending/proposalCheck'
import { getPrivateLendingWasm, type PrivateLendingWasm } from '@/privateLending/wasm'
import type { PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'
import { ErrorHandler } from '@/utils/errorHandler'
import { formatBlockSpan } from '@/utils/format'

import { bookSummary } from './bookSummary'
import LedgerTable, { ActionCell, Cell, type LedgerColumn, ScanNote } from './LedgerTable'
import SummaryStrip from './SummaryStrip'
import TermsBadge from './TermsBadge'

/** A proposal is accepted here; the loan book tracks the rest. */
const PROPOSAL_ACTIONS: OfferActions<LenderAction, 'private_accept_offer'> = {
  labels: LENDER_ACTION_LABELS,
  danger: 'liquidate',
  actionOfKind: { private_accept_offer: 'accept' },
}

const PAIR: TermsPair = {
  collateral: NETWORK_CONFIG.collateralAsset,
  principal: NETWORK_CONFIG.principalAsset,
}

const COLUMNS: LedgerColumn[] = [
  { label: 'Received' },
  { label: 'Borrower' },
  { label: 'Principal', align: 'right' },
  { label: 'Collateral', align: 'right' },
  { label: `Per 1 ${PAIR.collateral.symbol}`, align: 'right' },
  { label: 'APR', align: 'right' },
  { label: 'Term', align: 'right' },
  { label: 'Against your terms' },
  { label: 'Action', hideLabel: true },
]

/** What the table shows of a proposal beyond its amounts, from the wasm's display rules. */
interface ProposalFigures {
  /** The term, counted by the term rule from the block its creation confirmed in. */
  termBlocks: number
  /** Null when the wasm cannot give one: a term of 0, or a repayment below the principal. */
  aprBps: bigint | null
  /** Principal base units per 10^8 collateral base units; null for 0 collateral. */
  principalPerCollateral: bigint | null
  verdict: TermsVerdict | undefined
}

function orNull<T>(compute: () => T): T | null {
  try {
    return compute()
  } catch {
    // A `bad-input` error of a display rule: the figure is not shown.
    return null
  }
}

function figuresOf(
  wasm: PrivateLendingWasm,
  item: OpenedOfferItem,
  own: OwnEntry | undefined,
): ProposalFigures {
  const { terms, candidate } = item
  const termBlocks = termBlocksOf(terms.loanExpirationTime, candidate.created_at_height)
  return {
    termBlocks,
    aprBps: orNull(() => wasm.aprBps(terms.principalAmount, terms.repaymentAmount, termBlocks)),
    principalPerCollateral: orNull(() =>
      wasm.principalPerCollateral(terms.principalAmount, terms.collateralAmount),
    ),
    // The proposal against the terms the lender's key signed, by the same term rule.
    verdict:
      own === undefined
        ? undefined
        : checkAgainstTerms(
            wasm,
            own.check,
            proposalOfOffer(terms, candidate.created_at_height),
            PAIR,
          ),
  }
}

/** A decimal with its whole part grouped: `"59,523.8095"`. */
function grouped(decimal: string): string {
  const [whole, fraction] = decimal.split('.')
  const wholeGrouped = BigInt(whole).toLocaleString('en-US')
  return fraction === undefined ? wholeGrouped : `${wholeGrouped}.${fraction}`
}

const MISSING = <span className='text-muted'>–</span>

interface ProposalRowProps {
  item: OpenedOfferItem
  figures: ProposalFigures | undefined
  borrowerName: string | undefined
  tipHeight: number
  ownFailed: boolean
  state: OfferActionState<LenderAction>
  onOpen: (action: LenderAction, item: OpenedOfferItem, unsentTx?: PrivateTxRecord) => void
}

function ProposalRow({
  item,
  figures,
  borrowerName,
  tipHeight,
  ownFailed,
  state,
  onOpen,
}: ProposalRowProps) {
  const { formatCollateralDisplay, formatPrincipalAmount } = useFormatAmount()
  const { terms, candidate } = item
  const createdAt = candidate.created_at_height
  const age = tipHeight - createdAt

  return (
    <tr className='hover:bg-[var(--table-row-hover)]'>
      <Cell className='whitespace-nowrap' title={`Confirmed in block #${createdAt}`}>
        {tipHeight === 0 ? `#${createdAt}` : age < 1 ? 'Just now' : `${formatBlockSpan(age)} ago`}
      </Cell>
      <Cell>
        <KeyFingerprint fingerprint={terms.borrowerFingerprint} name={borrowerName} />
      </Cell>
      <Cell align='right'>{formatPrincipalAmount(terms.principalAmount)}</Cell>
      <Cell align='right'>{formatCollateralDisplay(terms.collateralAmount)}</Cell>
      <Cell align='right'>
        {figures?.principalPerCollateral != null
          ? `${grouped(
              maxPrincipalPerCollateralToDisplay(
                figures.principalPerCollateral,
                PAIR.principal.decimals,
                PAIR.collateral.decimals,
              ),
            )} ${PAIR.principal.symbol}`
          : MISSING}
      </Cell>
      <Cell align='right'>
        {figures?.aprBps != null ? formatAprBps(Number(figures.aprBps)) : MISSING}
      </Cell>
      <Cell align='right' title={`Expires at block #${terms.loanExpirationTime}`}>
        {figures === undefined ? MISSING : formatDays(figures.termBlocks / BLOCKS_PER_DAY)}
      </Cell>
      <Cell className='min-w-48'>
        <TermsBadge verdict={figures?.verdict} failed={ownFailed} />
      </Cell>
      {/* Review waits for the check against the lender's terms, which the acceptance shows. */}
      <ActionCell state={state} isDisabled={figures?.verdict === undefined} onOpen={onOpen} />
    </tr>
  )
}

function formatDays(days: number): string {
  return `${days.toLocaleString('en-US')} ${days === 1 ? 'day' : 'days'}`
}

interface ModalRequest {
  item: OpenedOfferItem
  verdict: TermsVerdict
  unsentTx?: PrivateTxRecord
}

/**
 * The lender's proposals: the book's figures, then the pending offers addressed to the wallet's
 * lending key, newest first, each checked against the lender's own verified terms. Review opens
 * the acceptance, which warns about a proposal outside the terms; nothing is accepted without it.
 */
export default function ProposalsPage() {
  const offers = usePrivateOffers()
  const { own, ownQuery, lookup } = useDirectory()
  const { data: tipHeight } = useBlockHeight()
  const { privateTxs } = usePendingTransactions()
  const { data: wasm } = useQuery({
    queryKey: privateLendingWasmQueryKey(),
    queryFn: getPrivateLendingWasm,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  const { modal, isOpen, open, close } = useKeyedModal<ModalRequest>()

  const lending = useMemo(() => offers.data?.lending ?? [], [offers.data])
  const opened = useMemo(() => lending.filter(isOpenedOffer), [lending])
  const proposals = useMemo(
    () =>
      opened
        .filter(item => item.candidate.status === 'pending')
        .sort((a, b) => b.candidate.created_at_height - a.candidate.created_at_height),
    [opened],
  )
  const figures = useMemo(
    () =>
      new Map(
        wasm === undefined ? [] : proposals.map(item => [item.txid, figuresOf(wasm, item, own)]),
      ),
    [wasm, proposals, own],
  )
  const summary = useMemo(() => bookSummary(opened, tipHeight), [opened, tipHeight])
  const unopened = lending.length - opened.length
  const ownFailed = own === undefined && ownQuery.isError
  const borrowerName = (item: OpenedOfferItem) => lookup(item.terms.borrowerPublicKey)?.display_name

  return (
    <div className='flex flex-col gap-6'>
      <header className='flex flex-wrap items-end justify-between gap-2'>
        <div className='flex flex-col gap-1'>
          <h1 className='text-foreground text-2xl font-semibold'>Proposals</h1>
          <p className='text-muted text-sm'>
            Proposals addressed to your lending key, checked against your published terms.
          </p>
        </div>
        <ScanNote offers={offers} />
      </header>

      {offers.data !== undefined && <SummaryStrip summary={summary} tipHeight={tipHeight} />}

      {ownFailed && (
        <Notice role='alert' className='flex flex-wrap items-center justify-between gap-2'>
          <span>
            Your terms could not be loaded, so proposals cannot be checked against them:{' '}
            {ErrorHandler.describe(ownQuery.error)}
          </span>
          <UiButton size='sm' variant='ghost' onPress={() => void ownQuery.refetch()}>
            Try again
          </UiButton>
        </Notice>
      )}

      <LedgerTable
        offers={offers}
        caption='Proposals waiting for you'
        columns={COLUMNS}
        isEmpty={proposals.length === 0}
        loadingText='Scanning for proposals addressed to you…'
        emptyText='No proposals are waiting for you.'
      >
        {proposals.map(item => (
          <ProposalRow
            key={item.txid}
            item={item}
            figures={figures.get(item.txid)}
            borrowerName={borrowerName(item)}
            tipHeight={tipHeight}
            ownFailed={ownFailed}
            state={offerActionState(
              privateTxs,
              item,
              PROPOSAL_ACTIONS,
              opened => lenderView(opened, tipHeight),
              lenderSendable(tipHeight),
            )}
            onOpen={(action, opened, unsentTx) => {
              const verdict = figures.get(opened.txid)?.verdict
              if (action === 'accept' && verdict !== undefined) {
                open({ item: opened, verdict, unsentTx })
              }
            }}
          />
        ))}
      </LedgerTable>

      <div className='text-muted flex flex-col gap-1 text-xs'>
        {unopened > 0 && (
          <p>
            Not shown: {unopened} {unopened === 1 ? 'offer' : 'offers'} addressed to your key that
            failed verification, whose terms could not be opened, that use other assets, or that the
            indexer no longer lists.
          </p>
        )}
        <p>Accepting asks you to confirm the terms and sign; nothing is accepted automatically.</p>
      </div>

      {modal !== null && (
        <AcceptPrivateOfferModal
          key={modal.key}
          isOpen={isOpen}
          item={modal.request.item}
          verdict={modal.request.verdict}
          counterpartyName={borrowerName(modal.request.item)}
          unsentTx={modal.request.unsentTx}
          onClose={close}
        />
      )}
    </div>
  )
}
