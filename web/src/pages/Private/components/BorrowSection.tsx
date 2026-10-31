import { Chip } from '@heroui/react'
import { useState } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import { getTxExplorerUrl } from '@/api/esplora/utils'
import CoinsIcon from '@/components/icons/CoinsIcon'
import CancelPrivateOfferModal from '@/components/modals/private/CancelPrivateOfferModal'
import ClaimPrincipalModal from '@/components/modals/private/ClaimPrincipalModal'
import CreatePrivateOfferModal, {
  type PrivateOfferDraft,
} from '@/components/modals/private/CreatePrivateOfferModal'
import RepayPrivateOfferModal from '@/components/modals/private/RepayPrivateOfferModal'
import { OfferStatusChip } from '@/components/OfferStatusChip'
import { UiButton } from '@/components/ui/UiButton'
import { repaymentBorrowerNftOutpoint, unspentUtxo } from '@/privateLending/candidate'
import { useDirectory } from '@/privateLending/hooks/useDirectory'
import { type PrivateOfferItem, usePrivateOffers } from '@/privateLending/hooks/usePrivateOffers'
import {
  isPastExpiry,
  type OfferTxState,
  offerTxState,
  type OpenedOfferItem,
} from '@/privateLending/offerView'
import type { PrivateTxKind, PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'
import { truncateAddress } from '@/utils/format'

import CreatePrivateOfferForm from './CreatePrivateOfferForm'
import PrivateOfferActionRow, { type OfferActions, type OfferView } from './PrivateOfferActionRow'
import PrivateOfferList, { ScanHeight } from './PrivateOfferList'
import { useKeyedModal } from './useKeyedModal'

type BorrowerAction = 'cancel' | 'claimPrincipal' | 'repay'

const BORROWER_ACTIONS: OfferActions<
  BorrowerAction,
  'private_cancel_offer' | 'private_claim_principal' | 'private_repay_offer'
> = {
  labels: { cancel: 'Cancel', claimPrincipal: 'Claim Principal', repay: 'Repay' },
  danger: 'cancel',
  actionOfKind: {
    private_cancel_offer: 'cancel',
    private_claim_principal: 'claimPrincipal',
    private_repay_offer: 'repay',
  },
}

const CREATE_TX_KINDS = ['private_create_offer'] as const satisfies readonly PrivateTxKind[]

/**
 * What the borrower can do with its offer, from the indexer's view of it (untrusted: the action's
 * builder checks every outpoint): cancel a pending offer, claim the principal while it is
 * unspent, then repay an active loan. Repaying burns the borrower NFT, the only key to an
 * unclaimed principal, so it is offered only on positive evidence that the principal was claimed
 * (`repaymentBorrowerNftOutpoint`): a candidate that omits the principal gets no Repay.
 */
function borrowerView(item: OpenedOfferItem, tipHeight: number): OfferView<BorrowerAction> {
  const { candidate, terms } = item
  const expired = isPastExpiry(terms, tipHeight)
  const principalUnclaimed = unspentUtxo(candidate, 'principal') !== undefined
  switch (candidate.status) {
    case 'pending':
      if (unspentUtxo(candidate, 'pending_offer') === undefined) return {}
      return {
        action: 'cancel',
        note: expired
          ? 'Its term has passed. Cancel it to take your collateral back.'
          : 'Waiting for the lender to accept it.',
      }
    case 'active':
      if (principalUnclaimed) {
        return { action: 'claimPrincipal', note: 'The lender accepted: claim your principal.' }
      }
      if (unspentUtxo(candidate, 'active_offer') === undefined) return {}
      if (repaymentBorrowerNftOutpoint(item.txid, candidate) === undefined) {
        return { note: 'The indexer lists no claim of your principal, so it cannot be repaid yet.' }
      }
      return {
        action: 'repay',
        note: expired
          ? 'The loan has expired: the lender may liquidate it.'
          : `Repay by block #${terms.loanExpirationTime}.`,
      }
    case 'liquidated':
      // The lender took the collateral; the principal it paid is still the borrower's.
      return principalUnclaimed
        ? { action: 'claimPrincipal', note: 'The loan was liquidated; the principal is yours.' }
        : {}
    default:
      return {}
  }
}

/** A creation this browser made that the scan has not found yet. */
function PendingCreationRow({
  txState,
  onBroadcastAgain,
}: {
  txState: OfferTxState<'private_create_offer'>
  onBroadcastAgain: () => void
}) {
  const { record } = txState
  const isUnsent = txState.state === 'unsent'
  return (
    <li className='bg-surface flex flex-col gap-3 rounded-2xl p-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <span className='text-foreground text-sm font-medium'>Your new offer</span>
        <div className='flex flex-wrap items-center gap-2'>
          {isUnsent ? (
            <>
              <Chip color='warning' variant='soft' size='sm'>
                Not broadcast
              </Chip>
              <UiButton size='sm' variant='secondary' onPress={onBroadcastAgain}>
                Broadcast Again
              </UiButton>
            </>
          ) : (
            <OfferStatusChip status='pending' isProcessing />
          )}
        </div>
      </div>
      <div className='text-muted flex flex-wrap items-center justify-between gap-2 text-xs'>
        <span>
          Offer{' '}
          <a
            className='text-accent font-mono hover:underline'
            href={getTxExplorerUrl(record.txid)}
            target='_blank'
            rel='noopener noreferrer'
          >
            {truncateAddress(record.txid)}
          </a>
        </span>
        <span>
          {isUnsent
            ? 'It was signed but not broadcast.'
            : record.confirmationStatus === 'processing'
              ? 'It waits for its confirmation.'
              : 'It is confirmed; it shows here once the indexer lists it.'}
        </span>
      </div>
    </li>
  )
}

type ModalRequest =
  | { kind: 'action'; action: BorrowerAction; item: OpenedOfferItem; unsentTx?: PrivateTxRecord }
  | { kind: 'create'; draft?: PrivateOfferDraft; unsentTx?: PrivateTxRecord }

/** The borrower's own offers, found by scanning, and the form for a new one. */
export default function BorrowSection() {
  const offers = usePrivateOffers()
  const { lookup } = useDirectory()
  const { data: tipHeight } = useBlockHeight()
  const { privateTxs } = usePendingTransactions()
  const { modal, isOpen, open, close } = useKeyedModal<ModalRequest>()
  // A new form after each creation: empty fields, and the wallet's coins read again.
  const [formKey, setFormKey] = useState(0)

  const items = offers.data?.borrowing ?? []
  const lenderName = (item: PrivateOfferItem) =>
    item.terms ? lookup(item.terms.lenderPublicKey)?.display_name : undefined

  // Creations from this browser until the scan lists them (their own txid is the offer's), shown
  // whatever state the scan is in: an unsent one must stay reachable.
  const pendingCreations = privateTxs
    .filter(
      record =>
        record.kind === 'private_create_offer' && !items.some(item => item.txid === record.txid),
    )
    .flatMap(record => {
      const txState = offerTxState(privateTxs, record.txid, CREATE_TX_KINDS)
      return txState ? [txState] : []
    })
  const hasUnsentCreation = pendingCreations.some(txState => txState.state === 'unsent')

  const renderModal = () => {
    if (modal === null) return null
    const { key, request } = modal
    if (request.kind === 'create') {
      return (
        <CreatePrivateOfferModal
          key={key}
          isOpen={isOpen}
          draft={request.draft}
          unsentTx={request.unsentTx}
          onClose={close}
          onCreated={() => setFormKey(formKey => formKey + 1)}
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

  return (
    <section className='bg-surface-secondary flex flex-col gap-6 rounded-3xl p-6'>
      <header className='flex flex-wrap items-start justify-between gap-2'>
        <div className='flex flex-col gap-1'>
          <div className='flex items-center gap-2'>
            <CoinsIcon className='size-5' />
            <h2 className='text-foreground text-[11px] font-semibold tracking-wide uppercase'>
              Borrow: Your Offers
            </h2>
          </div>
          <p className='text-muted text-sm'>
            Offers you made to a lender&apos;s key. Only you and that lender can read their terms.
          </p>
        </div>
        <ScanHeight offers={offers} />
      </header>

      <CreatePrivateOfferForm
        key={formKey}
        hasUnsentCreation={hasUnsentCreation}
        onReview={draft => open({ kind: 'create', draft })}
      />

      {pendingCreations.length > 0 && (
        <ul className='flex flex-col gap-2'>
          {pendingCreations.map(txState => (
            <PendingCreationRow
              key={txState.record.txid}
              txState={txState}
              onBroadcastAgain={() => open({ kind: 'create', unsentTx: txState.record })}
            />
          ))}
        </ul>
      )}

      <PrivateOfferList
        offers={offers}
        isEmpty={items.length === 0}
        loadingText='Scanning for your offers…'
        emptyText='You have no private offers yet.'
      >
        {items.map(item => (
          <PrivateOfferActionRow
            key={item.txid}
            item={item}
            counterpartyName={lenderName(item)}
            tipHeight={tipHeight}
            actions={BORROWER_ACTIONS}
            viewOf={opened => borrowerView(opened, tipHeight)}
            onOpen={(action, opened, unsentTx) =>
              open({ kind: 'action', action, item: opened, unsentTx })
            }
          />
        ))}
      </PrivateOfferList>

      {renderModal()}
    </section>
  )
}
