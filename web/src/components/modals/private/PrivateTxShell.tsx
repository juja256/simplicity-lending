import { type MutationStatus, useMutation } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'

import OfferActionShell, { type OfferAction } from '@/components/modals/OfferActionShell'
import Notice from '@/components/Notice'
import type { TransactionSummaryRow } from '@/components/TransactionModal'
import { UiButton, type UiButtonProps } from '@/components/ui/UiButton'
import {
  PrivateBroadcastError,
  usePrivateTransaction,
} from '@/privateLending/hooks/usePrivateTransaction'
import type { PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'

export interface PrivateTxShellProps {
  isOpen: boolean
  title: string
  chip: ReactNode
  label: string
  variant?: UiButtonProps['variant']
  eyebrow: string
  summary: TransactionSummaryRow[]
  disabled?: boolean
  /**
   * A transaction saved by an earlier attempt that no broadcast accepted: the modal opens on
   * broadcasting it again, as saved.
   */
  unsentTx?: PrivateTxRecord
  /** Builds, signs, saves and broadcasts, through `usePrivateTransaction().run`. */
  execute: () => Promise<{ txid: string }>
  /** Must resolve before a saved transaction is broadcast again, such as a check of the tip. */
  beforeBroadcast?: () => Promise<void>
  /**
   * Why the saved transaction can no longer be broadcast, from the tip the page shows, or null
   * while it can: the modal then offers only to discard it. `beforeBroadcast` still checks a
   * fresh tip.
   */
  unsentBlockedNote?: string | null
  onClose: () => void
  /** Called on closing after a broadcast went through. */
  onSuccess?: () => void
  /** Shown under the details while nothing is unsent, such as why the action is disabled. */
  notice?: ReactNode
  /** What the transaction does, shown before it runs and while it waits to be broadcast again. */
  children: ReactNode
}

interface Unsent {
  txid: string
  message: string | null
}

/**
 * A private transaction in a modal: its details, then on confirm `execute`, with the stepper of
 * `OfferActionShell`. If only the broadcast fails, the signed transaction is saved, and the modal
 * offers to broadcast it again (never to rebuild it) or to discard it.
 */
export default function PrivateTxShell({
  isOpen,
  title,
  chip,
  label,
  variant,
  eyebrow,
  summary,
  disabled,
  unsentTx,
  execute,
  beforeBroadcast,
  unsentBlockedNote = null,
  onClose,
  onSuccess,
  notice,
  children,
}: PrivateTxShellProps) {
  const { retryBroadcast } = usePrivateTransaction()
  const { removePrivateTx } = usePendingTransactions()

  const [unsent, setUnsent] = useState<Unsent | null>(() =>
    unsentTx ? { txid: unsentTx.txid, message: unsentTx.errorMessage ?? null } : null,
  )
  const keepUnsent = (error: Error) => {
    if (error instanceof PrivateBroadcastError) {
      setUnsent({ txid: error.txid, message: error.message })
    }
  }

  const run = useMutation({ mutationFn: execute, onError: keepUnsent })
  const retry = useMutation({
    mutationFn: (txid: string) => retryBroadcast(txid, beforeBroadcast),
    onError: keepUnsent,
  })

  // A failed broadcast returns to the form, which then offers to broadcast again, unless the
  // saved transaction can no longer be sent: then it offers only "Discard".
  const retryStatus: MutationStatus =
    retry.error instanceof PrivateBroadcastError ? 'idle' : retry.status
  const blocked = unsent !== null && unsentBlockedNote !== null
  const action: OfferAction | undefined =
    unsent !== null
      ? blocked && retryStatus === 'idle'
        ? undefined
        : {
            label: 'Broadcast again',
            eyebrow,
            summary,
            status: retryStatus,
            txid: retry.data,
            onConfirm: () => retry.mutate(unsent.txid),
          }
      : {
          label,
          variant,
          eyebrow,
          summary,
          status: run.status,
          disabled,
          txid: run.data?.txid,
          onConfirm: () => run.mutate(),
        }

  const close = () => {
    run.reset()
    retry.reset()
    onClose()
  }

  return (
    <OfferActionShell
      isOpen={isOpen}
      title={title}
      chip={chip}
      action={action}
      onClose={close}
      onSuccess={onSuccess}
    >
      <div className='flex flex-col gap-4'>
        {children}
        {unsent !== null ? (
          <Notice role='alert' className='flex flex-col gap-2'>
            <p>
              The transaction was signed and saved in this browser, but it was not broadcast
              {unsent.message ? `: ${unsent.message}` : '.'}
            </p>
            {blocked ? (
              <p>{unsentBlockedNote} It can only be discarded.</p>
            ) : (
              <p>
                Broadcasting again sends the same transaction. Discard it only if it can no longer
                be mined, for example because its coins were spent since.
              </p>
            )}
            <UiButton
              className='self-start'
              variant='ghost'
              size='sm'
              onPress={() => {
                void removePrivateTx(unsent.txid)
                close()
              }}
            >
              Discard
            </UiButton>
          </Notice>
        ) : (
          notice
        )}
      </div>
    </OfferActionShell>
  )
}
