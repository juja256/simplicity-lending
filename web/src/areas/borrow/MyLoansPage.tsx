import { buttonVariants, Skeleton, Spinner } from '@heroui/react'
import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'

import { useBlockHeight } from '@/api/esplora/hooks'
import { getTxExplorerUrl } from '@/api/esplora/utils'
import ArrowSquareOutIcon from '@/components/icons/ArrowSquareOutIcon'
import KeyFingerprint from '@/components/KeyFingerprint'
import CancelPrivateOfferModal from '@/components/modals/private/CancelPrivateOfferModal'
import ClaimPrincipalModal from '@/components/modals/private/ClaimPrincipalModal'
import CreatePrivateOfferModal from '@/components/modals/private/CreatePrivateOfferModal'
import { MessagesLink } from '@/components/modals/private/LoanMessagesModal'
import RepayPrivateOfferModal from '@/components/modals/private/RepayPrivateOfferModal'
import Notice from '@/components/Notice'
import { OffersLoadError } from '@/components/OffersLoadError'
import { ScanNote } from '@/components/ScanNote'
import { UiButton } from '@/components/ui/UiButton'
import { RoutePath } from '@/constants/routes'
import { useKeyedModal } from '@/hooks/useKeyedModal'
import { useDirectory } from '@/privateLending/hooks/useDirectory'
import { type LoanFigures, useLoans } from '@/privateLending/hooks/useLoan'
import { type PrivateOfferItem, usePrivateOffers } from '@/privateLending/hooks/usePrivateOffers'
import {
  type BorrowerAction,
  borrowerActions,
  borrowerSendable,
  type BorrowerStatus,
  borrowerStatus,
  borrowerView,
  counterpartyOf,
  creationExpiredNote,
  creationSendable,
  dueText,
  isOpenedOffer,
  type OfferActionState,
  offerActionState,
  type OfferTxState,
  offerTxState,
  type OpenedOfferItem,
  type Sendable,
  TIP_UNKNOWN_NOTE,
  usesConfiguredAssets,
} from '@/privateLending/offerView'
import type { PrivateTxKind, PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'
import { ErrorHandler } from '@/utils/errorHandler'

import { amountText, loanAmounts } from './proposalForm'
import { PAIR } from './useLenders'

const { principal: PRINCIPAL, collateral: COLLATERAL } = PAIR

const CREATE_TX_KINDS = ['private_create_offer'] as const satisfies readonly PrivateTxKind[]

/** Base units as grouped whole coins and the symbol, as the proposal page writes them. */
function coins(units: bigint, asset: typeof PRINCIPAL): string {
  return `${amountText(units, asset.decimals)} ${asset.symbol}`
}

type Tone = 'warning' | 'accent' | 'success' | 'danger' | 'muted'

const DOT: Record<Tone, string> = {
  warning: 'bg-warning',
  accent: 'bg-accent',
  success: 'bg-success',
  danger: 'bg-danger',
  muted: 'bg-muted',
}

function toneOf(status: BorrowerStatus): Tone {
  switch (status.kind) {
    case 'waiting':
      return 'warning'
    case 'accepted':
      return 'accent'
    case 'active':
      // From the expiry block on, as the note says the term has ended (`borrowerTermEnded`).
      return status.blocksLeft !== null && status.blocksLeft <= 0 ? 'danger' : 'success'
    case 'collateralTaken':
      return 'danger'
    default:
      return 'muted'
  }
}

/**
 * A status in the borrower's words: "Waiting for Acme", "Active, due in 12 days", "Active, 300 of
 * 1,100 TEST repaid, due in 12 days" once the loan is read. `repayment` is the loan's repayment.
 */
function statusWords(
  status: BorrowerStatus,
  lenderName: string | undefined,
  repayment: bigint | undefined,
): ReactNode {
  switch (status.kind) {
    case 'waiting':
      return lenderName ? (
        <>
          Waiting for <bdi>{lenderName}</bdi>
        </>
      ) : (
        'Waiting for the lender'
      )
    case 'notAccepted':
      return 'Not accepted in time'
    case 'accepted':
      return 'Accepted'
    case 'active': {
      const parts = ['Active']
      if (status.paid !== undefined && repayment !== undefined) {
        const paid = amountText(status.paid, PRINCIPAL.decimals)
        parts.push(`${paid} of ${coins(repayment, PRINCIPAL)} repaid`)
      }
      if (status.blocksLeft !== null) parts.push(dueText(status.blocksLeft))
      return parts.join(', ')
    }
    case 'repaid':
      return 'Repaid'
    case 'cancelled':
      return 'Cancelled'
    case 'collateralTaken':
      return 'Collateral taken'
  }
}

/** A row's status, with a spinner while a transaction of this browser waits for confirmation. */
function StatusLine({
  tone,
  isProcessing,
  children,
}: {
  tone: Tone
  isProcessing?: boolean
  children: ReactNode
}) {
  return (
    <p className='text-foreground flex items-center gap-2 text-sm font-medium wrap-break-word'>
      {isProcessing ? (
        <Spinner size='sm' color='current' className='size-3 shrink-0' aria-hidden />
      ) : (
        <span className={`size-2 shrink-0 rounded-full ${DOT[tone]}`} aria-hidden />
      )}
      <span className='min-w-0'>{children}</span>
    </p>
  )
}

/** The order of the list: what needs the borrower first, then what waits, then what ended. */
const RANK: Record<BorrowerStatus['kind'], number> = {
  accepted: 0,
  active: 1,
  waiting: 2,
  notAccepted: 3,
  collateralTaken: 4,
  repaid: 5,
  cancelled: 6,
}

function rank(item: PrivateOfferItem, tipHeight: number): number {
  return isOpenedOffer(item) ? RANK[borrowerStatus(item, tipHeight).kind] : 7
}

/** Soonest expiry first among live loans; the most recent first among those that ended. */
function compare(a: PrivateOfferItem, b: PrivateOfferItem, tipHeight: number): number {
  const byRank = rank(a, tipHeight) - rank(b, tipHeight)
  if (byRank !== 0) return byRank
  const expiryA = a.terms?.loanExpirationTime ?? 0
  const expiryB = b.terms?.loanExpirationTime ?? 0
  return rank(a, tipHeight) < RANK.collateralTaken ? expiryA - expiryB : expiryB - expiryA
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex min-w-0 flex-col'>
      <dt className='text-muted text-xs'>{label}</dt>
      <dd className='text-foreground text-sm whitespace-nowrap tabular-nums'>{children}</dd>
    </div>
  )
}

interface LoanRowProps {
  item: PrivateOfferItem
  lenderName: string | undefined
  tipHeight: number
  /** The loan's figures once read on chain (`useLoan`). */
  loan: LoanFigures | undefined
  state: OfferActionState<BorrowerAction>
  onOpen: (action: BorrowerAction, item: OpenedOfferItem, unsentTx?: PrivateTxRecord) => void
}

/**
 * One loan: its lender by name and key, the link to its messages if it has any, what it lends
 * against what, its status, and the one action that applies now (`offerActionState`) with the
 * note why or what it waits for.
 */
function LoanRow({ item, lenderName, tipHeight, loan, state, onOpen }: LoanRowProps) {
  const { discardPrivateTx } = usePendingTransactions()
  const lender = counterpartyOf(item)
  const terms = item.terms !== null && usesConfiguredAssets(item.terms) ? item.terms : null
  const status = isOpenedOffer(item) ? borrowerStatus(item, tipHeight, loan) : null
  const { button, note, isProcessing } = state

  return (
    <li className='border-separator flex flex-col gap-3 border-b py-5 first:pt-0 last:border-b-0'>
      <div className='flex flex-wrap items-start justify-between gap-x-4 gap-y-2'>
        <div className='flex min-w-0 flex-col gap-1'>
          <p className='text-foreground text-base font-semibold wrap-break-word'>
            {lenderName ? <bdi>{lenderName}</bdi> : 'Unknown lender'}
          </p>
          {lender && (
            <p className='text-muted flex flex-wrap items-baseline gap-x-2 text-xs'>
              Lender key
              <KeyFingerprint fingerprint={lender.fingerprint} />
            </p>
          )}
          {isOpenedOffer(item) && <MessagesLink item={item} />}
        </div>
        {status !== null && (
          <StatusLine tone={toneOf(status)} isProcessing={isProcessing}>
            {statusWords(status, lenderName, terms?.repaymentAmount)}
          </StatusLine>
        )}
      </div>

      {terms && (
        <dl className='flex flex-wrap gap-x-8 gap-y-2'>
          <Figure label='Principal'>{coins(terms.principalAmount, PRINCIPAL)}</Figure>
          <Figure label='Collateral'>{coins(terms.collateralAmount, COLLATERAL)}</Figure>
        </dl>
      )}

      {(button || note) && (
        <div className='flex flex-wrap items-center gap-x-4 gap-y-2'>
          {button && (
            <UiButton
              variant={button.variant}
              className='max-w-full'
              onPress={() =>
                button.kind === 'open'
                  ? onOpen(button.action, button.item, button.unsentTx)
                  : discardPrivateTx(button.record.txid).catch((error: unknown) =>
                      console.warn('[MyLoans] Could not discard the transaction', error),
                    )
              }
            >
              <span className='min-w-0 truncate'>{button.label}</span>
            </UiButton>
          )}
          {note && <p className='text-muted min-w-0 flex-1 basis-48 text-sm'>{note}</p>}
        </div>
      )}
    </li>
  )
}

/** What a new proposal that was signed but not sent says, by `creationSendable`. */
function unsentNote(record: PrivateTxRecord, sendable: Sendable): string {
  switch (sendable) {
    case 'yes':
      return 'It was signed but not sent.'
    case 'unknown':
      return `It was signed but not sent. ${TIP_UNKNOWN_NOTE}`
    case 'expired':
      return `It was signed but not sent. ${creationExpiredNote(record.creationTerm)}`
  }
}

/**
 * A proposal this browser made that the scan has not found yet. One signed but not sent gets
 * "Broadcast again" while it can still count the days chosen (`creationSendable`), only "Discard"
 * once it cannot, and nothing while the tip is not known.
 */
function NewProposalRow({
  txState,
  tipHeight,
  onBroadcastAgain,
}: {
  txState: OfferTxState<'private_create_offer'>
  tipHeight: number
  onBroadcastAgain: () => void
}) {
  const { discardPrivateTx } = usePendingTransactions()
  const { record } = txState
  const isUnsent = txState.state === 'unsent'
  const isConfirmed = record.confirmationStatus !== 'processing'
  const sendable = creationSendable(record.creationTerm, tipHeight)

  return (
    <li className='border-separator flex flex-col gap-3 border-b py-5 first:pt-0 last:border-b-0'>
      <div className='flex flex-wrap items-start justify-between gap-x-4 gap-y-2'>
        <p className='text-foreground text-base font-semibold'>Your new proposal</p>
        <StatusLine tone='warning' isProcessing={!isUnsent && !isConfirmed}>
          {isUnsent ? 'Not sent' : isConfirmed ? 'Sent' : 'Sending'}
        </StatusLine>
      </div>
      <div className='flex flex-wrap items-center gap-x-4 gap-y-2'>
        {isUnsent && sendable === 'yes' && (
          <UiButton variant='secondary' onPress={onBroadcastAgain}>
            Broadcast again
          </UiButton>
        )}
        {isUnsent && sendable === 'expired' && (
          <UiButton
            variant='secondary'
            onPress={() =>
              discardPrivateTx(record.txid).catch((error: unknown) =>
                console.warn('[MyLoans] Could not discard the proposal', error),
              )
            }
          >
            Discard
          </UiButton>
        )}
        <p className='text-muted min-w-0 flex-1 basis-48 text-sm'>
          {isUnsent
            ? unsentNote(record, sendable)
            : isConfirmed
              ? 'It is confirmed, and shows here with its lender once the indexer lists it.'
              : 'It waits for its confirmation.'}{' '}
          <a
            className='text-accent inline-flex items-center gap-1 hover:underline'
            href={getTxExplorerUrl(record.txid)}
            target='_blank'
            rel='noopener noreferrer'
          >
            View transaction
            <ArrowSquareOutIcon className='size-3.5' aria-hidden />
          </a>
        </p>
      </div>
    </li>
  )
}

type ModalRequest =
  | { kind: 'action'; action: BorrowerAction; item: OpenedOfferItem; unsentTx?: PrivateTxRecord }
  | { kind: 'create'; unsentTx: PrivateTxRecord }

/**
 * The borrower's loans: one row per proposal it made, found by scanning, with its lender, its
 * figures, its status and the one action that applies now (cancel, receive the principal, repay in
 * installments or in full, close a loan its installments paid), or "Broadcast again" for a
 * transaction this browser signed but did not send.
 */
export default function MyLoansPage() {
  const offers = usePrivateOffers()
  const { lookup } = useDirectory()
  const { data: tipHeight } = useBlockHeight()
  const { privateTxs } = usePendingTransactions()
  const { modal, isOpen, open, close } = useKeyedModal<ModalRequest>()

  const items = useMemo(
    () => [...(offers.data?.borrowing ?? [])].sort((a, b) => compare(a, b, tipHeight)),
    [offers.data, tipHeight],
  )
  const lenderName = (item: PrivateOfferItem) =>
    item.terms ? lookup(item.terms.lenderPublicKey)?.display_name : undefined
  const loans = useLoans(useMemo(() => items.filter(isOpenedOffer), [items]))

  // Creations from this browser until the scan lists them (their own txid is the offer's), shown
  // whatever state the scan is in: an unsent one must stay reachable.
  const newProposals = privateTxs
    .filter(
      record =>
        record.kind === 'private_create_offer' && !items.some(item => item.txid === record.txid),
    )
    .flatMap(record => {
      const txState = offerTxState(privateTxs, record.txid, CREATE_TX_KINDS)
      return txState ? [txState] : []
    })

  const renderModal = () => {
    if (modal === null) return null
    const { key, request } = modal
    if (request.kind === 'create') {
      return (
        <CreatePrivateOfferModal
          key={key}
          isOpen={isOpen}
          unsentTx={request.unsentTx}
          onClose={close}
        />
      )
    }
    const props = {
      isOpen,
      item: request.item,
      counterpartyName: lenderName(request.item),
      unsentTx: request.unsentTx,
      onClose: close,
    }
    switch (request.action) {
      case 'cancel':
        return <CancelPrivateOfferModal key={key} {...props} />
      case 'claimPrincipal':
        return <ClaimPrincipalModal key={key} {...props} />
      case 'repay':
        return <RepayPrivateOfferModal key={key} {...props} />
    }
  }

  const renderLoans = () => {
    if (offers.data === undefined) {
      return offers.isError ? (
        <OffersLoadError
          title='Your loans couldn’t be loaded'
          error={offers.error}
          onRetry={() => void offers.refetch()}
        />
      ) : (
        <div className='flex flex-col gap-3'>
          <p role='status' className='text-muted text-sm'>
            Looking for your loans…
          </p>
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className='h-32 w-full rounded-2xl' />
          ))}
        </div>
      )
    }
    if (items.length === 0) {
      return newProposals.length > 0 ? null : (
        <div className='bg-background flex flex-col items-start gap-3 rounded-2xl px-4 py-6'>
          <p className='text-muted text-sm'>
            You have no loans yet. Choose a lender and propose one within its terms.
          </p>
          <Link to={RoutePath.Borrow} className={buttonVariants({ variant: 'primary' })}>
            Choose a lender
          </Link>
        </div>
      )
    }
    return (
      <ul className='flex flex-col'>
        {items.map(item => {
          const terms = item.terms
          const loan = loans.get(item.txid)?.figures
          // Repay names what the loan still owes, the repayment until the loan is read.
          const owed = loan?.remaining ?? terms?.repaymentAmount
          const actions = borrowerActions(
            terms && owed !== undefined
              ? loanAmounts(terms.principalAmount, owed, PRINCIPAL)
              : null,
          )
          return (
            <LoanRow
              key={item.txid}
              item={item}
              lenderName={lenderName(item)}
              tipHeight={tipHeight}
              loan={loan}
              state={offerActionState(
                privateTxs,
                item,
                actions,
                opened => borrowerView(opened, tipHeight, loan),
                borrowerSendable(tipHeight),
              )}
              onOpen={(action, opened, unsentTx) =>
                open({ kind: 'action', action, item: opened, unsentTx })
              }
            />
          )
        })}
      </ul>
    )
  }

  return (
    <div className='flex flex-col gap-6'>
      <header className='flex flex-col gap-1'>
        <h1 className='text-foreground text-2xl font-semibold'>My loans</h1>
        <p className='text-muted text-sm'>
          Your proposals and the loans lenders accepted. Only you and each lender can read them.
        </p>
        <ScanNote offers={offers} />
      </header>

      {offers.data !== undefined && offers.isError && (
        <Notice role='alert' className='flex flex-wrap items-center gap-2'>
          <span className='min-w-0 flex-1'>
            Your loans could not be refreshed: {ErrorHandler.describe(offers.error)}
          </span>
          <UiButton size='sm' variant='ghost' onPress={() => void offers.refetch()}>
            Try again
          </UiButton>
        </Notice>
      )}

      {newProposals.length > 0 && (
        <ul className='flex flex-col'>
          {newProposals.map(txState => (
            <NewProposalRow
              key={txState.record.txid}
              txState={txState}
              tipHeight={tipHeight}
              onBroadcastAgain={() => open({ kind: 'create', unsentTx: txState.record })}
            />
          ))}
        </ul>
      )}

      {renderLoans()}

      {renderModal()}
    </div>
  )
}
