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
 * A private transaction in a modal: its details, then on confirm `execute`, with the public
 * stepper. If only the broadcast fails, the signed transaction is saved, and the modal offers to
 * broadcast it again (never to rebuild it) or to discard it.
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
    mutationFn: (txid: string) => retryBroadcast(txid),
    onError: keepUnsent,
  })

  // A failed broadcast returns to the form, which then offers to broadcast again.
  const retryStatus: MutationStatus =
    retry.error instanceof PrivateBroadcastError ? 'idle' : retry.status
  const action: OfferAction =
    unsent !== null
      ? {
          label: 'Broadcast Again',
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
            <p>
              Broadcasting again sends the same transaction. Discard it only if it can no longer be
              mined, for example because its coins were spent since.
            </p>
            <UiButton
              className='self-start'
              variant='ghost'
              size='sm'
              onPress={() => {
                void removePrivateTx(unsent.txid)
                close()
              }}
            >
              Discard It
            </UiButton>
          </Notice>
        ) : (
          notice
        )}
      </div>
    </OfferActionShell>
  )
}
