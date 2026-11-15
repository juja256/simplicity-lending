import { UiButton } from '@/components/ui/UiButton'
import type { PrivateOfferItem } from '@/privateLending/hooks/usePrivateOffers'
import {
  type OfferActions,
  offerActionState,
  type OfferView,
  type OpenedOfferItem,
} from '@/privateLending/offerView'
import type { PrivateTxKind, PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'

import PrivateOfferRow from './PrivateOfferRow'

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

/** An offer row with its action, by the rules of `offerActionState`. */
export default function PrivateOfferActionRow<A extends string, K extends PrivateTxKind>({
  item,
  counterpartyName,
  tipHeight,
  actions,
  viewOf,
  onOpen,
}: PrivateOfferActionRowProps<A, K>) {
  const { privateTxs } = usePendingTransactions()
  const { note, isProcessing, button } = offerActionState(privateTxs, item, actions, viewOf)

  return (
    <PrivateOfferRow
      item={item}
      counterpartyName={counterpartyName}
      tipHeight={tipHeight}
      isProcessing={isProcessing}
      note={note}
      actions={
        button && (
          <UiButton
            size='sm'
            variant={button.variant}
            onPress={() => onOpen(button.action, button.item, button.unsentTx)}
          >
            {button.label}
          </UiButton>
        )
      }
    />
  )
}
