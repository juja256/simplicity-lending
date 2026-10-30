import { type ReactNode, useState } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import HandCoinsIcon from '@/components/icons/HandCoinsIcon'
import AcceptPrivateOfferModal from '@/components/modals/private/AcceptPrivateOfferModal'
import ClaimRepaymentModal from '@/components/modals/private/ClaimRepaymentModal'
import LiquidatePrivateOfferModal from '@/components/modals/private/LiquidatePrivateOfferModal'
import { UiButton } from '@/components/ui/UiButton'
import { useDirectory } from '@/privateLending/hooks/useDirectory'
import { type PrivateOfferItem, usePrivateOffers } from '@/privateLending/hooks/usePrivateOffers'
import {
  isOpenedOffer,
  isPastExpiry,
  offerTxState,
  type OpenedOfferItem,
  unspentUtxo,
  usesConfiguredAssets,
} from '@/privateLending/offerView'
import type { PrivateTxKind, PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'

import PrivateOfferList, { ScanHeight } from './PrivateOfferList'
import PrivateOfferRow from './PrivateOfferRow'

type LenderAction = 'accept' | 'claim' | 'liquidate'

const LENDER_TX_KINDS = [
  'private_accept_offer',
  'private_claim_repayment',
  'private_liquidate_offer',
] as const satisfies readonly PrivateTxKind[]

const ACTION_OF_KIND: Record<(typeof LENDER_TX_KINDS)[number], LenderAction> = {
  private_accept_offer: 'accept',
  private_claim_repayment: 'claim',
  private_liquidate_offer: 'liquidate',
}

const ACTION_LABEL: Record<LenderAction, string> = {
  accept: 'Accept',
  claim: 'Claim Repayment',
  liquidate: 'Liquidate',
}

interface LenderView {
  action?: LenderAction
  note?: ReactNode
}

/**
 * What the lender can do with an offer, from the indexer's view of it (untrusted: the action's
 * builder checks every outpoint): accept a pending offer before its expiry, claim an unspent
 * repayment, liquidate an active loan once the tip is past its expiry.
 */
function lenderView(item: PrivateOfferItem, tipHeight: number): LenderView {
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
  switch (candidate.status) {
    case 'pending':
      return expired ? { note: 'Its term has passed.' } : { action: 'accept' }
    case 'active':
      if (unspentUtxo(candidate, 'active_offer') === undefined) return {}
      return expired
        ? { action: 'liquidate', note: 'The loan has expired unpaid.' }
        : { note: `Liquidation opens after block #${terms.loanExpirationTime}.` }
    case 'repaid':
      return unspentUtxo(candidate, 'repayment') !== undefined
        ? { action: 'claim', note: 'The borrower repaid the loan.' }
        : {}
    default:
      return {}
  }
}

interface ModalState {
  key: number
  action: LenderAction
  item: OpenedOfferItem
  unsentTx?: PrivateTxRecord
}

/** The lender's inbox: the offers addressed to the wallet's lending key, found by scanning. */
export default function LendSection() {
  const offers = usePrivateOffers()
  const { lookup } = useDirectory()
  const { data: tipHeight } = useBlockHeight()
  const { privateTxs } = usePendingTransactions()

  const [modal, setModal] = useState<ModalState | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const openModal = (action: LenderAction, item: OpenedOfferItem, unsentTx?: PrivateTxRecord) => {
    // A fresh key per opening: each opening starts with fresh state, and the last one stays
    // mounted while it closes.
    setModal(previous => ({ key: (previous?.key ?? 0) + 1, action, item, unsentTx }))
    setIsModalOpen(true)
  }

  const items = offers.data?.lending ?? []
  const borrowerName = (item: PrivateOfferItem) =>
    item.terms ? lookup(item.terms.borrowerPublicKey)?.display_name : undefined

  const renderRow = (item: PrivateOfferItem) => {
    const txState = offerTxState(privateTxs, item.txid, LENDER_TX_KINDS)
    const view = lenderView(item, tipHeight)
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
            onPress={() => openModal(ACTION_OF_KIND[record.kind], item, record)}
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
          variant={action === 'liquidate' ? 'danger-soft' : 'primary'}
          onPress={() => openModal(action, item)}
        >
          {ACTION_LABEL[action]}
        </UiButton>
      )
    }
    return (
      <PrivateOfferRow
        key={item.txid}
        item={item}
        counterpartyName={borrowerName(item)}
        tipHeight={tipHeight}
        isProcessing={txState?.state === 'processing'}
        note={note}
        actions={actions}
      />
    )
  }

  const renderModal = () => {
    if (modal === null) return null
    const props = {
      isOpen: isModalOpen,
      item: modal.item,
      counterpartyName: borrowerName(modal.item),
      unsentTx: modal.unsentTx,
      onClose: () => setIsModalOpen(false),
    }
    switch (modal.action) {
      case 'accept':
        return <AcceptPrivateOfferModal key={modal.key} {...props} />
      case 'claim':
        return <ClaimRepaymentModal key={modal.key} {...props} />
      case 'liquidate':
        return <LiquidatePrivateOfferModal key={modal.key} {...props} />
    }
  }

  return (
    <section className='bg-surface-secondary flex flex-col gap-6 rounded-3xl p-6'>
      <header className='flex flex-wrap items-start justify-between gap-2'>
        <div className='flex flex-col gap-1'>
          <div className='flex items-center gap-2'>
            <HandCoinsIcon className='size-5' />
            <h2 className='text-foreground text-[11px] font-semibold tracking-wide uppercase'>
              Lend: Offers to You
            </h2>
          </div>
          <p className='text-muted text-sm'>
            Offers addressed to your lending key. This browser verifies each one before it offers
            any action.
          </p>
        </div>
        <ScanHeight offers={offers} />
      </header>

      <PrivateOfferList
        offers={offers}
        isEmpty={items.length === 0}
        loadingText='Scanning for offers addressed to you…'
        emptyText='No offers addressed to you yet.'
      >
        {items.map(renderRow)}
      </PrivateOfferList>

      {renderModal()}
    </section>
  )
}
