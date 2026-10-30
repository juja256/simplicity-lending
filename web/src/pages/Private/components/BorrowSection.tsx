import { Chip } from '@heroui/react'
import { type ReactNode, useState } from 'react'

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
import { useDirectory } from '@/privateLending/hooks/useDirectory'
import { type PrivateOfferItem, usePrivateOffers } from '@/privateLending/hooks/usePrivateOffers'
import {
  isOpenedOffer,
  isPastExpiry,
  type OfferTxState,
  offerTxState,
  type OpenedOfferItem,
  unspentUtxo,
  usesConfiguredAssets,
} from '@/privateLending/offerView'
import type { PrivateTxKind, PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'
import { truncateAddress } from '@/utils/format'

import CreatePrivateOfferForm from './CreatePrivateOfferForm'
import PrivateOfferList, { ScanHeight } from './PrivateOfferList'
import PrivateOfferRow from './PrivateOfferRow'

type BorrowerAction = 'cancel' | 'claimPrincipal' | 'repay'

const BORROWER_TX_KINDS = [
  'private_cancel_offer',
  'private_claim_principal',
  'private_repay_offer',
] as const satisfies readonly PrivateTxKind[]

const CREATE_TX_KINDS = ['private_create_offer'] as const satisfies readonly PrivateTxKind[]

const ACTION_OF_KIND: Record<(typeof BORROWER_TX_KINDS)[number], BorrowerAction> = {
  private_cancel_offer: 'cancel',
  private_claim_principal: 'claimPrincipal',
  private_repay_offer: 'repay',
}

const ACTION_LABEL: Record<BorrowerAction, string> = {
  cancel: 'Cancel',
  claimPrincipal: 'Claim Principal',
  repay: 'Repay',
}

interface BorrowerView {
  action?: BorrowerAction
  note?: ReactNode
}

/**
 * What the borrower can do with its offer, from the indexer's view of it (untrusted: the action's
 * builder checks every outpoint): cancel a pending offer, claim the principal while it is
 * unspent, then repay an active loan. Repaying burns the borrower NFT, the only key to the
 * principal, so it is offered only once the principal is claimed.
 */
function borrowerView(item: PrivateOfferItem, tipHeight: number): BorrowerView {
  if (item.result === 'invalid') return { note: 'It failed verification: no action is possible.' }
  if (item.terms === null) {
    return { note: 'Its terms could not be opened; retried on the next sync.' }
  }
  if (item.candidate === null) return { note: 'The indexer no longer lists this offer.' }
  if (!usesConfiguredAssets(item.terms)) {
    return { note: 'It uses assets this app does not support.' }
  }
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

type ModalState = ModalRequest & { key: number }

/** The borrower's own offers, found by scanning, and the form for a new one. */
export default function BorrowSection() {
  const offers = usePrivateOffers()
  const { lookup } = useDirectory()
  const { data: tipHeight } = useBlockHeight()
  const { privateTxs } = usePendingTransactions()

  const [modal, setModal] = useState<ModalState | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const openModal = (request: ModalRequest) => {
    // A fresh key per opening: each opening starts with fresh state, and the last one stays
    // mounted while it closes.
    setModal(previous => ({ ...request, key: (previous?.key ?? 0) + 1 }))
    setIsModalOpen(true)
  }
  // A new form after each creation: empty fields, and the wallet's coins read again.
  const [formKey, setFormKey] = useState(0)

  const items = offers.data?.borrowing ?? []
  const lenderName = (item: PrivateOfferItem) =>
    item.terms ? lookup(item.terms.lenderPublicKey)?.display_name : undefined

  // Creations from this browser until the scan lists them; their own txid is the offer's.
  const pendingCreations =
    offers.data === undefined
      ? []
      : privateTxs
          .filter(
            record =>
              record.kind === 'private_create_offer' &&
              !items.some(item => item.txid === record.txid),
          )
          .flatMap(record => {
            const txState = offerTxState(privateTxs, record.txid, CREATE_TX_KINDS)
            return txState ? [txState] : []
          })

  const renderRow = (item: PrivateOfferItem) => {
    const txState = offerTxState(privateTxs, item.txid, BORROWER_TX_KINDS)
    const view = borrowerView(item, tipHeight)
    let actions: ReactNode = null
    let note = view.note
    if (txState?.state === 'unsent') {
      note = 'Your transaction was signed but not broadcast.'
      const { record } = txState
      if (isOpenedOffer(item)) {
        actions = (
          <UiButton
            size='sm'
            variant='secondary'
            onPress={() =>
              openModal({
                kind: 'action',
                action: ACTION_OF_KIND[record.kind],
                item,
                unsentTx: record,
              })
            }
          >
            Broadcast Again
          </UiButton>
        )
      }
    } else if (txState?.state === 'processing') {
      note = 'Your transaction waits for its confirmation.'
    } else if (view.action !== undefined && isOpenedOffer(item)) {
      const action = view.action
      actions = (
        <UiButton
          size='sm'
          variant={action === 'cancel' ? 'danger-soft' : 'primary'}
          onPress={() => openModal({ kind: 'action', action, item })}
        >
          {ACTION_LABEL[action]}
        </UiButton>
      )
    }
    return (
      <PrivateOfferRow
        key={item.txid}
        item={item}
        counterpartyName={lenderName(item)}
        tipHeight={tipHeight}
        isProcessing={txState?.state === 'processing'}
        note={note}
        actions={actions}
      />
    )
  }

  const renderModal = () => {
    if (modal === null) return null
    const onClose = () => setIsModalOpen(false)
    if (modal.kind === 'create') {
      return (
        <CreatePrivateOfferModal
          key={modal.key}
          isOpen={isModalOpen}
          draft={modal.draft}
          unsentTx={modal.unsentTx}
          onClose={onClose}
          onCreated={() => setFormKey(key => key + 1)}
        />
      )
    }
    const props = {
      isOpen: isModalOpen,
      item: modal.item,
      counterpartyName: lenderName(modal.item),
      unsentTx: modal.unsentTx,
      onClose,
    }
    switch (modal.action) {
      case 'cancel':
        return <CancelPrivateOfferModal key={modal.key} {...props} />
      case 'claimPrincipal':
        return <ClaimPrincipalModal key={modal.key} {...props} />
      case 'repay':
        return <RepayPrivateOfferModal key={modal.key} {...props} />
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
        onReview={draft => openModal({ kind: 'create', draft })}
      />

      <PrivateOfferList
        offers={offers}
        isEmpty={items.length === 0 && pendingCreations.length === 0}
        loadingText='Scanning for your offers…'
        emptyText='You have no private offers yet.'
      >
        {pendingCreations.map(txState => (
          <PendingCreationRow
            key={txState.record.txid}
            txState={txState}
            onBroadcastAgain={() => openModal({ kind: 'create', unsentTx: txState.record })}
          />
        ))}
        {items.map(renderRow)}
      </PrivateOfferList>

      {renderModal()}
    </section>
  )
}
