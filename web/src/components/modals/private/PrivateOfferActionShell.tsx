import { type MutationStatus, useMutation } from '@tanstack/react-query'
import { type ReactNode, useMemo, useState } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import DetailsPanel, { type DetailRow } from '@/components/DetailsPanel'
import OfferActionShell, { type OfferAction } from '@/components/modals/OfferActionShell'
import { OfferStatusChip } from '@/components/OfferStatusChip'
import type { TransactionSummaryRow } from '@/components/TransactionModal'
import { UiButton, type UiButtonProps } from '@/components/ui/UiButton'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import type { AsyncUpdatedPset, UpdatedPset } from '@/lwk/transaction'
import KeyFingerprint from '@/pages/Private/components/KeyFingerprint'
import { displayStatus, type OpenedOfferItem } from '@/pages/Private/helpers'
import type { PrivateFlowDeps } from '@/privateLending/deps'
import { usePrivateFlowDeps } from '@/privateLending/hooks/usePrivateFlowDeps'
import { useLoadVerifiedOffer } from '@/privateLending/hooks/usePrivateOffers'
import {
  PrivateBroadcastError,
  usePrivateTransaction,
} from '@/privateLending/hooks/usePrivateTransaction'
import type { VerifiedOffer } from '@/privateLending/verify'
import type { PrivateTxKind, PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'
import { useWallet } from '@/providers/wallet/useWallet'
import { formatTermLeft, truncateAddress } from '@/utils/format'

/** What every private action modal takes. */
export interface PrivateOfferActionModalProps {
  isOpen: boolean
  item: OpenedOfferItem
  /** The counterparty's directory name, if it is listed. */
  counterpartyName?: string
  /**
   * A transaction of this action saved by an earlier attempt that no broadcast accepted: the
   * modal opens on broadcasting it again, as saved.
   */
  unsentTx?: PrivateTxRecord
  onClose: () => void
}

interface PrivateOfferActionShellProps<TSummary> extends PrivateOfferActionModalProps {
  kind: Exclude<PrivateTxKind, 'private_create_offer'>
  title: string
  chip: ReactNode
  label: string
  variant?: UiButtonProps['variant']
  eyebrow: string
  summary: TransactionSummaryRow[]
  disabled?: boolean
  /** Shown under the offer details, such as why the action is disabled. */
  notice?: ReactNode
  /**
   * Builds the transaction from the wallet's current coins and the offer, loaded fresh through
   * the gate with the same `deps`.
   */
  build: (
    deps: PrivateFlowDeps,
    offer: VerifiedOffer,
  ) => Promise<UpdatedPset<TSummary> | AsyncUpdatedPset<TSummary>>
}

interface Unsent {
  txid: string
  message: string | null
}

function OfferDetails({
  item,
  counterpartyName,
}: {
  item: OpenedOfferItem
  counterpartyName?: string
}) {
  const { formatCollateralDisplay, formatPrincipalAmount } = useFormatAmount()
  const { data: tipHeight } = useBlockHeight()
  const { terms, candidate } = item
  const status = displayStatus(candidate)
  const isLive = status === 'pending' || status === 'active'
  const isLender = item.role === 'lender'

  const rows = useMemo<DetailRow[]>(
    () => [
      { label: 'Offer', value: truncateAddress(item.txid), copyValue: item.txid },
      {
        label: isLender ? 'Borrower' : 'Lender',
        value: (
          <KeyFingerprint
            fingerprint={isLender ? terms.borrowerFingerprint : terms.lenderFingerprint}
            name={counterpartyName}
          />
        ),
      },
      { label: 'Collateral', value: formatCollateralDisplay(terms.collateralAmount) },
      { label: 'Principal', value: formatPrincipalAmount(terms.principalAmount) },
      { label: 'Repayment', value: formatPrincipalAmount(terms.repaymentAmount) },
      {
        label: 'Interest',
        value: formatPrincipalAmount(terms.interest),
        tooltip: 'The repayment minus the principal.',
      },
      {
        label: 'Expiry Block',
        value:
          isLive && tipHeight > 0
            ? `#${terms.loanExpirationTime} (${formatTermLeft(terms.loanExpirationTime - tipHeight)})`
            : `#${terms.loanExpirationTime}`,
      },
      { label: 'Status', value: <OfferStatusChip status={status} /> },
    ],
    [
      item.txid,
      isLender,
      terms,
      counterpartyName,
      formatCollateralDisplay,
      formatPrincipalAmount,
      isLive,
      tipHeight,
      status,
    ],
  )

  return <DetailsPanel rows={rows} />
}

/**
 * A private offer action: the offer's details, then on confirm the build through
 * `usePrivateTransaction` with the offer loaded fresh, never the listed result. If only the
 * broadcast fails, the signed transaction is saved, and the modal offers to broadcast it again
 * (never to rebuild it) or to discard it.
 */
export default function PrivateOfferActionShell<TSummary>({
  isOpen,
  item,
  counterpartyName,
  unsentTx,
  onClose,
  kind,
  title,
  chip,
  label,
  variant,
  eyebrow,
  summary,
  disabled,
  notice,
  build,
}: PrivateOfferActionShellProps<TSummary>) {
  const { syncWallet } = useWallet()
  const getDeps = usePrivateFlowDeps()
  const loadOffer = useLoadVerifiedOffer()
  const { run, retryBroadcast } = usePrivateTransaction()
  const { removePrivateTx } = usePendingTransactions()

  const [unsent, setUnsent] = useState<Unsent | null>(() =>
    unsentTx ? { txid: unsentTx.txid, message: unsentTx.errorMessage ?? null } : null,
  )
  const keepUnsent = (error: Error) => {
    if (error instanceof PrivateBroadcastError) {
      setUnsent({ txid: error.txid, message: error.message })
    }
  }

  const execute = useMutation({
    mutationFn: async () => {
      // The opened offer holds the offer's secrets: freed once the transaction is finalized.
      const held: { offer?: VerifiedOffer } = {}
      try {
        return await run({ kind, offerTxid: item.txid }, async () => {
          await syncWallet()
          const deps = await getDeps()
          held.offer = await loadOffer(deps, item.txid, item.role)
          return build(deps, held.offer)
        })
      } finally {
        held.offer?.opened.free()
      }
    },
    onError: keepUnsent,
  })

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
          status: execute.status,
          disabled,
          txid: execute.data?.txid,
          onConfirm: () => execute.mutate(),
        }

  const close = () => {
    execute.reset()
    retry.reset()
    onClose()
  }

  return (
    <OfferActionShell isOpen={isOpen} title={title} chip={chip} action={action} onClose={close}>
      <div className='flex flex-col gap-4'>
        <OfferDetails item={item} counterpartyName={counterpartyName} />
        {unsent !== null ? (
          <div
            role='alert'
            className='border-warning/30 bg-warning/10 text-warning flex flex-col gap-2 rounded-2xl border px-4 py-3 text-sm'
          >
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
          </div>
        ) : (
          notice
        )}
      </div>
    </OfferActionShell>
  )
}
