import { Chip } from '@heroui/react'
import { useMemo } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import KeyFingerprint from '@/components/KeyFingerprint'
import ClaimRepaymentModal from '@/components/modals/private/ClaimRepaymentModal'
import LiquidatePrivateOfferModal from '@/components/modals/private/LiquidatePrivateOfferModal'
import { OfferStatusChip } from '@/components/OfferStatusChip'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { useKeyedModal } from '@/hooks/useKeyedModal'
import { useDirectory } from '@/privateLending/hooks/useDirectory'
import { usePrivateOffers } from '@/privateLending/hooks/usePrivateOffers'
import {
  displayStatus,
  isOpenedOffer,
  isPastExpiry,
  LENDER_ACTION_LABELS,
  type LenderAction,
  lenderSendable,
  lenderView,
  type OfferActions,
  type OfferActionState,
  offerActionState,
  type OpenedOfferItem,
} from '@/privateLending/offerView'
import type { PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'
import { formatBlockSpan } from '@/utils/format'

import LedgerTable, { ActionCell, Cell, type LedgerColumn, ScanNote } from './LedgerTable'

/** A loan is claimed or liquidated here; proposals are accepted on their own page. */
const LOAN_ACTIONS: OfferActions<
  LenderAction,
  'private_claim_repayment' | 'private_liquidate_offer'
> = {
  labels: LENDER_ACTION_LABELS,
  danger: 'liquidate',
  actionOfKind: {
    private_claim_repayment: 'claim',
    private_liquidate_offer: 'liquidate',
  },
}

const COLUMNS: LedgerColumn[] = [
  { label: 'Borrower' },
  { label: 'Lent', align: 'right' },
  { label: 'Collateral', align: 'right' },
  { label: 'Repayment', align: 'right' },
  { label: 'Due', align: 'right' },
  { label: 'Status' },
  { label: 'Action', hideLabel: true },
]

/** The statuses of a loan: accepted once, whatever happened since. */
const LOAN_STATUSES = new Set(['active', 'repaid', 'liquidated'])

/**
 * The order of the book: overdue loans first, then active ones, then repayments to claim, then
 * closed loans; by expiry within each.
 */
function rank(item: OpenedOfferItem, tipHeight: number): number {
  const status = displayStatus(item.candidate)
  if (status === 'active') return isPastExpiry(item.terms, tipHeight) ? 0 : 1
  return status === 'repaid' ? 2 : 3
}

/** When an active loan is due, from the tip: `in 41 days`, `2 days ago`. */
function dueLabel(expiry: number, tipHeight: number): string {
  if (tipHeight === 0) return `Block #${expiry}`
  const blocksLeft = expiry - tipHeight
  if (blocksLeft === 0) return 'This block'
  return blocksLeft > 0
    ? `in ${formatBlockSpan(blocksLeft)}`
    : `${formatBlockSpan(-blocksLeft)} ago`
}

interface LoanRowProps {
  item: OpenedOfferItem
  borrowerName: string | undefined
  tipHeight: number
  state: OfferActionState<LenderAction>
  onOpen: (action: LenderAction, item: OpenedOfferItem, unsentTx?: PrivateTxRecord) => void
}

function LoanRow({ item, borrowerName, tipHeight, state, onOpen }: LoanRowProps) {
  const { formatCollateralDisplay, formatPrincipalAmount } = useFormatAmount()
  const { terms, candidate } = item
  const status = displayStatus(candidate)
  const overdue = status === 'active' && isPastExpiry(terms, tipHeight)

  return (
    <tr className='hover:bg-[var(--table-row-hover)]'>
      <Cell>
        <KeyFingerprint fingerprint={terms.borrowerFingerprint} name={borrowerName} />
      </Cell>
      <Cell align='right'>{formatPrincipalAmount(terms.principalAmount)}</Cell>
      <Cell align='right'>{formatCollateralDisplay(terms.collateralAmount)}</Cell>
      <Cell align='right'>{formatPrincipalAmount(terms.repaymentAmount)}</Cell>
      <Cell align='right' title={`Expires at block #${terms.loanExpirationTime}`}>
        {status === 'active' ? (
          dueLabel(terms.loanExpirationTime, tipHeight)
        ) : (
          <span className='text-muted'>Block #{terms.loanExpirationTime}</span>
        )}
      </Cell>
      <Cell>
        {overdue && !state.isProcessing ? (
          <Chip color='danger' variant='soft' size='sm'>
            <span className='mr-1 size-1.5 shrink-0 rounded-full bg-current' aria-hidden='true' />
            Overdue
          </Chip>
        ) : (
          <OfferStatusChip status={status} isProcessing={state.isProcessing} />
        )}
      </Cell>
      <ActionCell state={state} onOpen={onOpen} />
    </tr>
  )
}

interface ModalRequest {
  action: LenderAction
  item: OpenedOfferItem
  unsentTx?: PrivateTxRecord
}

/**
 * The lender's loan book: the accepted offers addressed to the wallet's lending key, active,
 * repaid and closed, with Claim for an unclaimed repayment and Liquidate for an overdue loan.
 */
export default function LoanBookPage() {
  const offers = usePrivateOffers()
  const { lookup } = useDirectory()
  const { data: tipHeight } = useBlockHeight()
  const { privateTxs } = usePendingTransactions()
  const { modal, isOpen, open, close } = useKeyedModal<ModalRequest>()

  const loans = useMemo(
    () =>
      (offers.data?.lending ?? [])
        .filter(isOpenedOffer)
        .filter(item => LOAN_STATUSES.has(item.candidate.status))
        .sort(
          (a, b) =>
            rank(a, tipHeight) - rank(b, tipHeight) ||
            a.terms.loanExpirationTime - b.terms.loanExpirationTime,
        ),
    [offers.data, tipHeight],
  )
  const borrowerName = (item: OpenedOfferItem) => lookup(item.terms.borrowerPublicKey)?.display_name

  const renderModal = () => {
    if (modal === null) return null
    const { key, request } = modal
    const props = {
      isOpen,
      item: request.item,
      counterpartyName: borrowerName(request.item),
      unsentTx: request.unsentTx,
      onClose: close,
    }
    switch (request.action) {
      case 'claim':
        return <ClaimRepaymentModal key={key} {...props} />
      case 'liquidate':
        return <LiquidatePrivateOfferModal key={key} {...props} />
      case 'accept':
        // Proposals are accepted on their own page: `lenderView` gives no loan this action.
        return null
    }
  }

  return (
    <div className='flex flex-col gap-6'>
      <header className='flex flex-wrap items-end justify-between gap-2'>
        <div className='flex flex-col gap-1'>
          <h1 className='text-foreground text-2xl font-semibold'>Loan book</h1>
          <p className='text-muted text-sm'>The proposals you accepted, and how each loan ended.</p>
        </div>
        <ScanNote offers={offers} />
      </header>

      <LedgerTable
        offers={offers}
        caption='Your loans'
        columns={COLUMNS}
        isEmpty={loans.length === 0}
        loadingText='Scanning for your loans…'
        emptyText='No loans yet. A proposal you accept appears here once it confirms.'
      >
        {loans.map(item => (
          <LoanRow
            key={item.txid}
            item={item}
            borrowerName={borrowerName(item)}
            tipHeight={tipHeight}
            state={offerActionState(
              privateTxs,
              item,
              LOAN_ACTIONS,
              opened => lenderView(opened, tipHeight),
              lenderSendable(tipHeight),
            )}
            onOpen={(action, opened, unsentTx) => open({ action, item: opened, unsentTx })}
          />
        ))}
      </LedgerTable>

      <p className='text-muted text-xs'>
        Only you and each borrower can see these loans. On chain, amounts and terms are hidden.
      </p>

      {renderModal()}
    </div>
  )
}
