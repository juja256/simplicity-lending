import { Chip } from '@heroui/react'
import { useMemo } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import KeyFingerprint from '@/components/KeyFingerprint'
import ClaimInstallmentsModal from '@/components/modals/private/ClaimInstallmentsModal'
import ClaimRepaymentModal from '@/components/modals/private/ClaimRepaymentModal'
import LiquidatePrivateOfferModal from '@/components/modals/private/LiquidatePrivateOfferModal'
import { OfferStatusChip } from '@/components/OfferStatusChip'
import { ScanNote } from '@/components/ScanNote'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { useKeyedModal } from '@/hooks/useKeyedModal'
import { useDirectory } from '@/privateLending/hooks/useDirectory'
import { type LoanRead, useLoans } from '@/privateLending/hooks/useLoan'
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
import { ErrorHandler } from '@/utils/errorHandler'
import { formatBlockSpan } from '@/utils/format'

import { bookSummary, type LoanBookFigures, loanBookFigures } from './bookSummary'
import LedgerTable, { ActionCell, Cell, type LedgerColumn } from './LedgerTable'

/** A loan's installments are claimed, its repayment claimed, or it is liquidated here. */
const LOAN_ACTIONS: OfferActions<
  LenderAction,
  'private_claim_installments' | 'private_claim_repayment' | 'private_liquidate_offer'
> = {
  labels: LENDER_ACTION_LABELS,
  danger: 'liquidate',
  actionOfKind: {
    private_claim_installments: 'claimInstallments',
    private_claim_repayment: 'claimRepayment',
    private_liquidate_offer: 'liquidate',
  },
}

const COLUMNS: LedgerColumn[] = [
  { label: 'Borrower' },
  { label: 'Lent', align: 'right' },
  { label: 'Collateral', align: 'right' },
  { label: 'Repayment', align: 'right' },
  { label: 'Repaid', align: 'right' },
  { label: 'Remaining', align: 'right' },
  { label: 'Claimable', align: 'right' },
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
  /** The loan as read on chain (`useLoan`), with its figures in the book. */
  loan: LoanRead | undefined
  figures: LoanBookFigures | null
  state: OfferActionState<LenderAction>
  onOpen: (action: LenderAction, item: OpenedOfferItem, unsentTx?: PrivateTxRecord) => void
}

function LoanRow({ item, borrowerName, tipHeight, loan, figures, state, onOpen }: LoanRowProps) {
  const { formatCollateralDisplay, formatPrincipalAmount } = useFormatAmount()
  const { terms, candidate } = item
  const status = displayStatus(candidate)
  const overdue = status === 'active' && isPastExpiry(terms, tipHeight)
  const unread = figures === null
  const loanTitle = loan?.error
    ? `The loan could not be read: ${ErrorHandler.describe(loan.error)}`
    : undefined

  return (
    <tr className='hover:bg-[var(--table-row-hover)]'>
      <Cell>
        <KeyFingerprint fingerprint={terms.borrowerFingerprint} name={borrowerName} />
      </Cell>
      <Cell align='right'>{formatPrincipalAmount(terms.principalAmount)}</Cell>
      <Cell align='right'>{formatCollateralDisplay(terms.collateralAmount)}</Cell>
      <Cell align='right'>{formatPrincipalAmount(terms.repaymentAmount)}</Cell>
      <Cell align='right' title={loanTitle}>
        {unread ? <span className='text-muted'>–</span> : formatPrincipalAmount(figures.repaid)}
      </Cell>
      <Cell align='right' title={loanTitle}>
        {unread || figures.remaining === null ? (
          <span className='text-muted'>–</span>
        ) : figures.remaining.exact ? (
          formatPrincipalAmount(figures.remaining.amount)
        ) : (
          <span title='An installment does not open with your key: its amount is unknown.'>
            at most {formatPrincipalAmount(figures.remaining.amount)}
          </span>
        )}
      </Cell>
      <Cell align='right' title={loanTitle}>
        {unread || (figures.claimable === 0n && figures.unknownClaimable === 0) ? (
          <span className='text-muted'>–</span>
        ) : (
          <ClaimableText figures={figures} format={formatPrincipalAmount} />
        )}
      </Cell>
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

/**
 * What the lender can claim of a loan: the amount it reads, and "amount unknown" for installments
 * it cannot open, which only the final claim takes.
 */
function ClaimableText({
  figures,
  format,
}: {
  figures: LoanBookFigures
  format: (amount: bigint) => string
}) {
  const { claimable, unknownClaimable } = figures
  if (unknownClaimable === 0) return <>{format(claimable)}</>
  const unknown = (
    <span
      className='text-muted'
      title='An installment that does not open with your key: the final claim takes it.'
    >
      amount unknown
    </span>
  )
  return claimable === 0n ? (
    unknown
  ) : (
    <>
      {format(claimable)} + {unknown}
    </>
  )
}

interface ModalRequest {
  action: LenderAction
  item: OpenedOfferItem
  unsentTx?: PrivateTxRecord
}

/**
 * The lender's loan book: the accepted offers addressed to the wallet's lending key, active,
 * repaid and closed, with what each repaid, still owes and has to claim, as read on chain. Claim
 * takes the installments that open, Claim repayment sweeps a closed loan, and Liquidate takes an
 * overdue loan's collateral.
 */
export default function LoanBookPage() {
  const offers = usePrivateOffers()
  const { lookup } = useDirectory()
  const { data: tipHeight } = useBlockHeight()
  const { privateTxs } = usePendingTransactions()
  const { formatPrincipalAmount } = useFormatAmount()
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
  const reads = useLoans(loans)
  const figuresByTxid = new Map(
    loans.map(item => [item.txid, loanBookFigures(item, reads.get(item.txid)?.figures)]),
  )
  const read = new Map(
    loans.flatMap(item => {
      const figures = reads.get(item.txid)?.figures
      return figures === undefined ? [] : [[item.txid, figures] as const]
    }),
  )
  const { repaid, claimable } = bookSummary(loans, tipHeight, read)

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
      case 'claimInstallments':
        return <ClaimInstallmentsModal key={key} {...props} />
      case 'claimRepayment':
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

      {offers.data !== undefined && loans.length > 0 && (
        <dl className='flex flex-wrap gap-x-8 gap-y-2'>
          <div className='flex flex-col'>
            <dt className='text-muted text-xs'>Repaid to you</dt>
            <dd className='text-foreground text-lg font-semibold tabular-nums'>
              {formatPrincipalAmount(repaid)}
            </dd>
          </div>
          <div className='flex flex-col'>
            <dt className='text-muted text-xs'>Claimable now</dt>
            <dd className='text-foreground text-lg font-semibold tabular-nums'>
              {formatPrincipalAmount(claimable)}
            </dd>
          </div>
        </dl>
      )}

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
            loan={reads.get(item.txid)}
            figures={figuresByTxid.get(item.txid) ?? null}
            state={offerActionState(
              privateTxs,
              item,
              LOAN_ACTIONS,
              opened => lenderView(opened, tipHeight, reads.get(item.txid)?.figures),
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
