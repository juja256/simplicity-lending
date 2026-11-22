import { Chip } from '@heroui/react'
import { type ReactNode, useMemo } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import KeyFingerprint from '@/components/KeyFingerprint'
import ClaimInstallmentsModal from '@/components/modals/private/ClaimInstallmentsModal'
import ClaimRepaymentModal from '@/components/modals/private/ClaimRepaymentModal'
import LiquidatePrivateOfferModal from '@/components/modals/private/LiquidatePrivateOfferModal'
import { MessagesLink } from '@/components/modals/private/LoanMessagesModal'
import { OfferStatusChip } from '@/components/OfferStatusChip'
import { ScanNote } from '@/components/ScanNote'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { useKeyedModal } from '@/hooks/useKeyedModal'
import type { CollateralLeft } from '@/privateLending/collateralFigures'
import { useCollateralLeft } from '@/privateLending/hooks/useCollateralLeft'
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

// Paired figures stack in one cell, a figure over its muted companion, so that a row fits the
// console's width at 1280 px with every column shown.
const COLUMNS: LedgerColumn[] = [
  { label: 'Borrower' },
  // the principal, with the repayment under it
  { label: 'Lent', align: 'right' },
  // the offer's collateral, with what the loan released and has left under it
  { label: 'Collateral', align: 'right' },
  // what the borrower repaid, with what it still owes under it
  { label: 'Repaid', align: 'right' },
  { label: 'Claimable', align: 'right' },
  // the status, with when the loan is due under it
  { label: 'Status' },
  { label: 'Action', hideLabel: true },
]

/** A figure with its muted companion under it, both on one line each, aligned right. */
function Stacked({ children, under }: { children: ReactNode; under?: ReactNode }) {
  return (
    <div className='flex flex-col items-end'>
      <span>{children}</span>
      {under && <div className='text-muted flex flex-col items-end text-xs'>{under}</div>}
    </div>
  )
}

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

/** When an active loan is due, from the tip: `Due in 41 days`, `Due 2 days ago`. */
function dueLabel(expiry: number, tipHeight: number): string {
  if (tipHeight === 0) return `Due at block #${expiry}`
  const blocksLeft = expiry - tipHeight
  if (blocksLeft === 0) return 'Due this block'
  return blocksLeft > 0
    ? `Due in ${formatBlockSpan(blocksLeft)}`
    : `Due ${formatBlockSpan(-blocksLeft)} ago`
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

/**
 * A loan's collateral: the offer's, and under it, while the loan is active, what it released and
 * has left, or "computing" while the lender's search runs. The figures stack, so that the row fits
 * the console's width.
 */
function CollateralFigures({ total, state }: { total: bigint; state: CollateralLeft }) {
  // the unit is the total's, above
  const { formatCollateralAmount, formatCollateralDisplay } = useFormatAmount()
  const detail = (() => {
    switch (state.kind) {
      case 'known':
        return (
          <>
            <span>{formatCollateralAmount(state.released)} released</span>
            <span>{formatCollateralAmount(state.left)} left</span>
          </>
        )
      case 'computing':
        return (
          <span
            role='status'
            title='An installment does not open with your key: the app is searching for the collateral left. This takes a few seconds.'
          >
            computing…
          </span>
        )
      case 'unknown':
        return <span title='The collateral left could not be found.'>left unknown</span>
      case 'unread':
        return null
    }
  })()
  return <Stacked under={detail}>{formatCollateralDisplay(total)}</Stacked>
}

function LoanRow({ item, borrowerName, tipHeight, loan, figures, state, onOpen }: LoanRowProps) {
  const { formatPrincipalAmount } = useFormatAmount()
  const { terms, candidate } = item
  const status = displayStatus(candidate)
  const overdue = status === 'active' && isPastExpiry(terms, tipHeight)
  const unread = figures === null
  // While the loan is active; the search, when an installment does not open for the lender, runs
  // in a Web Worker and the cell says "computing" until it answers.
  const collateral = useCollateralLeft(terms.collateralAmount, loan?.figures, status === 'active')
  const loanTitle = loan?.error
    ? `The loan could not be read: ${ErrorHandler.describe(loan.error)}`
    : undefined

  return (
    <tr className='hover:bg-[var(--table-row-hover)]'>
      <Cell>
        <div className='flex flex-col items-start gap-0.5'>
          <KeyFingerprint fingerprint={terms.borrowerFingerprint} name={borrowerName} />
          <MessagesLink item={item} />
        </div>
      </Cell>
      <Cell align='right'>
        <Stacked under={`repays ${formatPrincipalAmount(terms.repaymentAmount)}`}>
          {formatPrincipalAmount(terms.principalAmount)}
        </Stacked>
      </Cell>
      <Cell align='right' title={loanTitle}>
        <CollateralFigures
          total={terms.collateralAmount}
          state={status === 'active' ? collateral : { kind: 'unread' }}
        />
      </Cell>
      <Cell align='right' title={loanTitle}>
        {unread ? (
          <span className='text-muted'>–</span>
        ) : (
          <Stacked
            under={
              figures.remaining === null ? undefined : figures.remaining.exact ? (
                `${formatPrincipalAmount(figures.remaining.amount)} owed`
              ) : (
                <span
                  className='flex flex-col items-end'
                  title='An installment does not open with your key: its amount is unknown.'
                >
                  <span>at most</span>
                  <span>{formatPrincipalAmount(figures.remaining.amount)} owed</span>
                </span>
              )
            }
          >
            {formatPrincipalAmount(figures.repaid)}
          </Stacked>
        )}
      </Cell>
      <Cell align='right' title={loanTitle}>
        {unread || (figures.claimable === 0n && figures.unknownClaimable === 0) ? (
          <span className='text-muted'>–</span>
        ) : (
          <ClaimableText figures={figures} format={formatPrincipalAmount} />
        )}
      </Cell>
      <Cell>
        <div className='flex flex-col items-start gap-1'>
          {overdue && !state.isProcessing ? (
            <Chip color='danger' variant='soft' size='sm'>
              <span className='mr-1 size-1.5 shrink-0 rounded-full bg-current' aria-hidden='true' />
              Overdue
            </Chip>
          ) : (
            <OfferStatusChip status={status} isProcessing={state.isProcessing} />
          )}
          <span
            className='text-muted text-xs whitespace-nowrap'
            title={`Expires at block #${terms.loanExpirationTime}`}
          >
            {status === 'active'
              ? dueLabel(terms.loanExpirationTime, tipHeight)
              : `Block #${terms.loanExpirationTime}`}
          </span>
        </div>
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
 * overdue loan's collateral. A loan with private messages links to their timeline.
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
