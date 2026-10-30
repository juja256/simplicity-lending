import { type ReactNode, useMemo } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import {
  fetchPrivateCandidate,
  type PrivateCandidateDetails,
  type PrivateUtxo,
  type PrivateUtxoType,
} from '@/api/indexer/private'
import DetailsPanel, { type DetailRow } from '@/components/DetailsPanel'
import KeyFingerprint from '@/components/KeyFingerprint'
import { OfferStatusChip } from '@/components/OfferStatusChip'
import type { TransactionSummaryRow } from '@/components/TransactionModal'
import type { UiButtonProps } from '@/components/ui/UiButton'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import type { AsyncUpdatedPset, UpdatedPset } from '@/lwk/transaction'
import type { PrivateFlowDeps } from '@/privateLending/deps'
import { PRIVATE_API_BASE_URL, usePrivateFlowDeps } from '@/privateLending/hooks/usePrivateFlowDeps'
import { useLoadVerifiedOffer } from '@/privateLending/hooks/usePrivateOffers'
import { usePrivateTransaction } from '@/privateLending/hooks/usePrivateTransaction'
import {
  counterpartyOf,
  displayStatus,
  expiryLabel,
  type OpenedOfferItem,
  PRIVATE_UTXO_LABEL,
  unspentUtxo,
} from '@/privateLending/offerView'
import type { VerifiedOffer } from '@/privateLending/verify'
import type { PrivateTxKind, PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { useWallet } from '@/providers/wallet/useWallet'
import { truncateAddress } from '@/utils/format'

import PrivateTxShell from './PrivateTxShell'

/** What every private offer action modal takes. */
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

/** What a build gets, all read at build time. */
export interface FreshOffer {
  /** Fresh deps: the wallet synced just before. */
  deps: PrivateFlowDeps
  /** The offer, loaded fresh through the gate with `deps`. */
  offer: VerifiedOffer
  /** The indexer's candidate, read again (untrusted: the builder checks every outpoint). */
  candidate: PrivateCandidateDetails
  /** The candidate's unspent UTXO of the type the action `requires`. */
  utxo: PrivateUtxo
}

interface PrivateOfferActionShellProps<TSummary> extends PrivateOfferActionModalProps {
  kind: Exclude<PrivateTxKind, 'private_create_offer'>
  /** The UTXO the action spends: nothing is built unless the indexer lists it unspent now. */
  requires: PrivateUtxoType
  title: string
  chip: ReactNode
  label: string
  variant?: UiButtonProps['variant']
  eyebrow: string
  summary: TransactionSummaryRow[]
  disabled?: boolean
  /** Shown under the offer details, such as why the action is disabled. */
  notice?: ReactNode
  build: (fresh: FreshOffer) => Promise<UpdatedPset<TSummary> | AsyncUpdatedPset<TSummary>>
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

  const rows = useMemo<DetailRow[]>(() => {
    const counterparty = counterpartyOf(item)
    return [
      { label: 'Offer', value: truncateAddress(item.txid), copyValue: item.txid },
      {
        label: counterparty.role === 'borrower' ? 'Borrower' : 'Lender',
        value: <KeyFingerprint fingerprint={counterparty.fingerprint} name={counterpartyName} />,
      },
      { label: 'Collateral', value: formatCollateralDisplay(terms.collateralAmount) },
      { label: 'Principal', value: formatPrincipalAmount(terms.principalAmount) },
      { label: 'Repayment', value: formatPrincipalAmount(terms.repaymentAmount) },
      {
        label: 'Interest',
        value: formatPrincipalAmount(terms.interest),
        tooltip: 'The repayment minus the principal.',
      },
      { label: 'Expiry Block', value: expiryLabel(terms.loanExpirationTime, status, tipHeight) },
      { label: 'Status', value: <OfferStatusChip status={status} /> },
    ]
  }, [
    item,
    terms,
    counterpartyName,
    formatCollateralDisplay,
    formatPrincipalAmount,
    tipHeight,
    status,
  ])

  return <DetailsPanel rows={rows} />
}

/**
 * An action on a private offer: the offer's details, then on confirm the build through
 * `usePrivateTransaction`, from what is read at that moment: the wallet synced, the candidate read
 * again with the UTXO the action spends still unspent, and the offer loaded fresh through the gate
 * (never the listed result). Broadcast failures are handled by `PrivateTxShell`.
 */
export default function PrivateOfferActionShell<TSummary>({
  isOpen,
  item,
  counterpartyName,
  unsentTx,
  onClose,
  kind,
  requires,
  build,
  ...shell
}: PrivateOfferActionShellProps<TSummary>) {
  const { syncWallet } = useWallet()
  const getDeps = usePrivateFlowDeps()
  const loadOffer = useLoadVerifiedOffer()
  const { run } = usePrivateTransaction()

  const execute = async () => {
    // The opened offer holds the offer's secrets: freed once the transaction is finalized.
    const held: { offer?: VerifiedOffer } = {}
    try {
      return await run({ kind, offerTxid: item.txid }, async () => {
        await syncWallet()
        const candidate = await fetchPrivateCandidate(item.txid, PRIVATE_API_BASE_URL)
        const utxo = unspentUtxo(candidate, requires)
        if (!utxo) {
          throw new Error(
            `The indexer lists no unspent ${PRIVATE_UTXO_LABEL[requires]} for this offer`,
          )
        }
        const deps = await getDeps()
        held.offer = await loadOffer(deps, item.txid, item.role)
        return build({ deps, offer: held.offer, candidate, utxo })
      })
    } finally {
      held.offer?.opened.free()
    }
  }

  return (
    <PrivateTxShell
      {...shell}
      isOpen={isOpen}
      unsentTx={unsentTx}
      execute={execute}
      onClose={onClose}
    >
      <OfferDetails item={item} counterpartyName={counterpartyName} />
    </PrivateTxShell>
  )
}
