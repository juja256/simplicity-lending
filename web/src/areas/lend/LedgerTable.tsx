import { Skeleton } from '@heroui/react'
import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import Notice from '@/components/Notice'
import { OffersLoadError } from '@/components/OffersLoadError'
import { UiButton } from '@/components/ui/UiButton'
import type { PrivateOffers } from '@/privateLending/hooks/usePrivateOffers'
import type { OfferActionState, OpenedOfferItem } from '@/privateLending/offerView'
import type { PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'
import { ErrorHandler } from '@/utils/errorHandler'

type OffersQuery = UseQueryResult<PrivateOffers>

export interface LedgerColumn {
  label: string
  /** Amounts align right. */
  align?: 'right'
  /** A column whose cells explain themselves, such as the actions: its label is for readers only. */
  hideLabel?: boolean
}

interface CellProps {
  /** Amounts align right, on one line. */
  align?: 'right'
  className?: string
  title?: string
  children: ReactNode
}

/** A row's cell. */
export function Cell({ align, className = '', title, children }: CellProps) {
  const alignClass = align === 'right' ? 'text-right whitespace-nowrap' : 'text-left'
  return (
    <td className={`px-3 py-2.5 align-middle ${alignClass} ${className}`} title={title}>
      {children}
    </td>
  )
}

interface ActionCellProps<A extends string> {
  state: OfferActionState<A>
  /** The row's figures are not ready yet: the button waits for them. */
  isDisabled?: boolean
  onOpen: (action: A, item: OpenedOfferItem, unsentTx?: PrivateTxRecord) => void
}

/**
 * A row's action (`offerActionState`): its button, which opens the action's modal or discards a
 * saved transaction, with the note why or what it waits for.
 */
export function ActionCell<A extends string>({ state, isDisabled, onOpen }: ActionCellProps<A>) {
  const { note, button } = state
  const { removePrivateTx } = usePendingTransactions()
  return (
    <td className='px-3 py-2.5 text-right align-middle'>
      <div className='flex flex-col items-end gap-1'>
        {button && (
          <UiButton
            size='sm'
            variant={button.variant}
            // Discarding drops a transaction that can no longer be sent: it waits for nothing.
            isDisabled={button.kind === 'open' && isDisabled}
            onPress={() =>
              button.kind === 'open'
                ? onOpen(button.action, button.item, button.unsentTx)
                : void removePrivateTx(button.record.txid)
            }
          >
            {button.label}
          </UiButton>
        )}
        {note && <span className='text-muted max-w-56 text-xs'>{note}</span>}
      </div>
    </td>
  )
}

interface LedgerTableProps {
  offers: OffersQuery
  /** What the table lists, for screen readers. */
  caption: string
  columns: LedgerColumn[]
  isEmpty: boolean
  loadingText: string
  emptyText: string
  /** The rows, `<tr>` elements with a cell per column. */
  children: ReactNode
}

/**
 * A ledger of the lender's offers through the scan's states: loading, failed, empty, or a table of
 * 13 px rows with tabular figures. A failed refresh keeps the rows already loaded, under a warning.
 */
export default function LedgerTable({
  offers,
  caption,
  columns,
  isEmpty,
  loadingText,
  emptyText,
  children,
}: LedgerTableProps) {
  if (offers.data === undefined) {
    return offers.isError ? (
      <OffersLoadError error={offers.error} onRetry={() => void offers.refetch()} />
    ) : (
      <div className='flex flex-col gap-2'>
        <p role='status' className='text-muted text-sm'>
          {loadingText}
        </p>
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className='h-10 w-full rounded' />
        ))}
      </div>
    )
  }

  return (
    <div className='flex flex-col gap-3'>
      {offers.isError && (
        <Notice role='alert' className='flex flex-wrap items-center justify-between gap-2'>
          <span>The list could not be refreshed: {ErrorHandler.describe(offers.error)}</span>
          <UiButton size='sm' variant='ghost' onPress={() => void offers.refetch()}>
            Try again
          </UiButton>
        </Notice>
      )}
      {isEmpty ? (
        <p className='border-separator text-muted rounded border border-dashed px-4 py-4 text-sm'>
          {emptyText}
        </p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full border-collapse text-[13px] tabular-nums'>
            <caption className='sr-only'>{caption}</caption>
            <thead>
              <tr className='border-separator text-muted border-b text-xs'>
                {columns.map(({ label, align, hideLabel }) => (
                  <th
                    key={label}
                    scope='col'
                    className={`px-3 py-2 font-medium whitespace-nowrap ${
                      align === 'right' ? 'text-right' : 'text-left'
                    }`}
                  >
                    {hideLabel ? <span className='sr-only'>{label}</span> : label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className='divide-separator divide-y'>{children}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}
