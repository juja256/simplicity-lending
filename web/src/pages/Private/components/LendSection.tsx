import { useBlockHeight } from '@/api/esplora/hooks'
import HandCoinsIcon from '@/components/icons/HandCoinsIcon'
import AcceptPrivateOfferModal from '@/components/modals/private/AcceptPrivateOfferModal'
import ClaimRepaymentModal from '@/components/modals/private/ClaimRepaymentModal'
import LiquidatePrivateOfferModal from '@/components/modals/private/LiquidatePrivateOfferModal'
import { unspentUtxo } from '@/privateLending/candidate'
import { useDirectory } from '@/privateLending/hooks/useDirectory'
import { type PrivateOfferItem, usePrivateOffers } from '@/privateLending/hooks/usePrivateOffers'
import { isPastExpiry, type OpenedOfferItem } from '@/privateLending/offerView'
import type { PrivateTxRecord } from '@/providers/pendingTransactions/types'

import PrivateOfferActionRow, { type OfferActions, type OfferView } from './PrivateOfferActionRow'
import PrivateOfferList, { ScanHeight } from './PrivateOfferList'
import { useKeyedModal } from './useKeyedModal'

type LenderAction = 'accept' | 'claim' | 'liquidate'

const LENDER_ACTIONS: OfferActions<
  LenderAction,
  'private_accept_offer' | 'private_claim_repayment' | 'private_liquidate_offer'
> = {
  labels: { accept: 'Accept', claim: 'Claim Repayment', liquidate: 'Liquidate' },
  danger: 'liquidate',
  actionOfKind: {
    private_accept_offer: 'accept',
    private_claim_repayment: 'claim',
    private_liquidate_offer: 'liquidate',
  },
}

/**
 * What the lender can do with an offer, from the indexer's view of it (untrusted: the action's
 * builder checks every outpoint): accept a pending offer before its expiry, claim an unspent
 * repayment, liquidate an active loan once the tip is past its expiry.
 */
function lenderView(item: OpenedOfferItem, tipHeight: number): OfferView<LenderAction> {
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

interface ModalRequest {
  action: LenderAction
  item: OpenedOfferItem
  unsentTx?: PrivateTxRecord
}

/** The lender's inbox: the offers addressed to the wallet's lending key, found by scanning. */
export default function LendSection() {
  const offers = usePrivateOffers()
  const { lookup } = useDirectory()
  const { data: tipHeight } = useBlockHeight()
  const { modal, isOpen, open, close } = useKeyedModal<ModalRequest>()

  const items = offers.data?.lending ?? []
  const borrowerName = (item: PrivateOfferItem) =>
    item.terms ? lookup(item.terms.borrowerPublicKey)?.display_name : undefined

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
      case 'accept':
        return <AcceptPrivateOfferModal key={key} {...props} />
      case 'claim':
        return <ClaimRepaymentModal key={key} {...props} />
      case 'liquidate':
        return <LiquidatePrivateOfferModal key={key} {...props} />
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
        {items.map(item => (
          <PrivateOfferActionRow
            key={item.txid}
            item={item}
            counterpartyName={borrowerName(item)}
            tipHeight={tipHeight}
            actions={LENDER_ACTIONS}
            viewOf={opened => lenderView(opened, tipHeight)}
            onOpen={(action, opened, unsentTx) => open({ action, item: opened, unsentTx })}
          />
        ))}
      </PrivateOfferList>

      {renderModal()}
    </section>
  )
}
