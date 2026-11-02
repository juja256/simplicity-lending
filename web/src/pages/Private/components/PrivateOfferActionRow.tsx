import type { ReactNode } from 'react'

import { UiButton } from '@/components/ui/UiButton'
import type { PrivateOfferItem } from '@/privateLending/hooks/usePrivateOffers'
import {
  blockedNote,
  isOpenedOffer,
  offerTxState,
  type OpenedOfferItem,
} from '@/privateLending/offerView'
import type { PrivateTxKind, PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'

import PrivateOfferRow from './PrivateOfferRow'

/** What the session may do with an opened offer, from the indexer's view of it (untrusted). */
export interface OfferView<A extends string> {
  action?: A
  note?: ReactNode
}

/** One side's actions on its offers. */
export interface OfferActions<A extends string, K extends PrivateTxKind> {
  labels: Record<A, string>
  /** The action shown as a danger button. */
  danger: A
  /** The action of each transaction kind: its modal broadcasts a saved one again. */
  actionOfKind: Record<K, A>
}

interface PrivateOfferActionRowProps<A extends string, K extends PrivateTxKind> {
  item: PrivateOfferItem
  /** The counterparty's directory name, if it is listed. */
  counterpartyName?: string
  /** The chain tip, or 0 while unknown. */
  tipHeight: number
  actions: OfferActions<A, K>
  /** The action and note of an offer that can be acted on at all. */
  viewOf: (item: OpenedOfferItem) => OfferView<A>
  onOpen: (action: A, item: OpenedOfferItem, unsentTx?: PrivateTxRecord) => void
}

/**
 * An offer row with its action, by the same rules on both sides. This browser's own transaction
 * for the offer, which the indexer may not show yet, comes first:
 * - one saved but not broadcast gets only "Broadcast Again", which opens its action's modal on
 *   the saved transaction: a retry never rebuilds, and no new build is offered meanwhile;
 * - one broadcast and not yet final gets no action until it is.
 *
 * Otherwise the row shows the side's `viewOf` for an offer that can be acted on at all, and only
 * the note why for one that cannot (`blockedNote`).
 */
export default function PrivateOfferActionRow<A extends string, K extends PrivateTxKind>({
  item,
  counterpartyName,
  tipHeight,
  actions,
  viewOf,
  onOpen,
}: PrivateOfferActionRowProps<A, K>) {
  const { privateTxs } = usePendingTransactions()
  const kinds = Object.keys(actions.actionOfKind) as K[]
  const txState = offerTxState(privateTxs, item.txid, kinds)
  const opened = isOpenedOffer(item) ? item : null
  const view: OfferView<A> = opened ? viewOf(opened) : { note: blockedNote(item) }

  let note = view.note
  let button: ReactNode = null
  if (txState?.state === 'unsent') {
    const { record } = txState
    note = 'Your transaction was signed but not broadcast.'
    if (opened) {
      button = (
        <UiButton
          size='sm'
          variant='secondary'
          onPress={() => onOpen(actions.actionOfKind[record.kind], opened, record)}
        >
          Broadcast Again
        </UiButton>
      )
    }
  } else if (txState?.state === 'processing') {
    note = 'Your transaction waits for its confirmation.'
  } else if (view.action !== undefined && opened) {
    const action = view.action
    button = (
      <UiButton
        size='sm'
        variant={action === actions.danger ? 'danger-soft' : 'primary'}
        onPress={() => onOpen(action, opened)}
      >
        {actions.labels[action]}
      </UiButton>
    )
  }

  return (
    <PrivateOfferRow
      item={item}
      counterpartyName={counterpartyName}
      tipHeight={tipHeight}
      isProcessing={txState?.state === 'processing'}
      note={note}
      actions={button}
    />
  )
}
