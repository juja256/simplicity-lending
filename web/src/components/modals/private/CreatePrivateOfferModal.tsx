import { Chip } from '@heroui/react'
import { useMemo } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import { fetchLatestBlockHeight } from '@/api/esplora/methods'
import DetailsPanel, { type DetailRow } from '@/components/DetailsPanel'
import KeyFingerprint from '@/components/KeyFingerprint'
import Notice from '@/components/Notice'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { buildPrivateCreation } from '@/privateLending/flows/creation'
import { usePrivateFlowDeps } from '@/privateLending/hooks/usePrivateFlowDeps'
import { usePrivateTransaction } from '@/privateLending/hooks/usePrivateTransaction'
import { proposalExpiryIsStale } from '@/privateLending/lenderTerms'
import { syncInSession } from '@/privateLending/lendingKeyHolder'
import { expiryLabel } from '@/privateLending/offerView'
import { selectCreationCoins, walletReceiver } from '@/privateLending/wallet'
import type { PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { useWallet } from '@/providers/wallet/useWallet'
import { truncateAddress } from '@/utils/format'

import PrivateTxShell from './PrivateTxShell'

/** A proposal as the borrower reviewed it. */
export interface PrivateOfferDraft {
  lender: {
    /** The lender's lending key, x-only hex, lowercase. */
    pubkey: string
    fingerprint: string
    /** Its directory name, if it is listed. */
    name?: string
  }
  collateralAmount: bigint
  principalAmount: bigint
  repaymentAmount: bigint
  /** The term the borrower chose, in days. */
  termDays: number
  /**
   * A block height: `proposalExpiry` of the tip when "Lock collateral and send" was pressed and
   * `termDays`. It is fixed then: a chain that moved on by the build refuses it.
   */
  loanExpirationTime: number
}

interface CreatePrivateOfferModalProps {
  isOpen: boolean
  /** The proposal to send. Absent when the modal opens on a saved creation that was not sent. */
  draft?: PrivateOfferDraft
  /** A creation saved by an earlier attempt that no broadcast accepted. */
  unsentTx?: PrivateTxRecord
  onClose: () => void
  /** Called on closing after the creation was broadcast. */
  onCreated?: () => void
}

/**
 * The borrower creates a private offer from a reviewed draft: the wallet's coins and a fresh
 * pair of NFTs, built at confirm time, then the borrower's self-check before it is saved and
 * broadcast. A failed broadcast is retried from the saved transaction, never rebuilt: a rebuild
 * would be another offer. The borrower app calls the offer a proposal and never names the NFTs or
 * the lending key, so neither does anything this modal shows.
 */
export default function CreatePrivateOfferModal({
  isOpen,
  draft,
  unsentTx,
  onClose,
  onCreated,
}: CreatePrivateOfferModalProps) {
  const { syncWallet, getLendingKey, getWalletTxOuts } = useWallet()
  const getDeps = usePrivateFlowDeps()
  const { run } = usePrivateTransaction()
  const { data: tipHeight } = useBlockHeight()
  const { formatCollateralDisplay, formatPrincipalAmount } = useFormatAmount()

  const execute = async () => {
    if (!draft) throw new Error('There is no proposal to send')
    return run({ kind: 'private_create_offer' }, async () => {
      const borrower = await syncInSession(getLendingKey, syncWallet)
      const [deps, tip] = await Promise.all([getDeps(), fetchLatestBlockHeight()])
      if (draft.lender.pubkey === borrower.xOnlyPublicKey()) {
        throw new Error('The lender key is your own')
      }
      if (proposalExpiryIsStale(draft.loanExpirationTime, tip, draft.termDays)) {
        throw new Error('Review the proposal again: the chain moved on.')
      }
      const coins = selectCreationCoins(
        await getWalletTxOuts(),
        deps.assets,
        draft.collateralAmount,
        deps.feeRate,
      )
      return buildPrivateCreation(deps, {
        borrower,
        lender: draft.lender.pubkey,
        ...coins,
        collateralAmount: draft.collateralAmount,
        principalAmount: draft.principalAmount,
        repaymentAmount: draft.repaymentAmount,
        loanExpirationTime: draft.loanExpirationTime,
        borrowerNftReceiver: walletReceiver(deps),
      })
    })
  }

  const rows = useMemo<DetailRow[]>(() => {
    if (!draft) {
      const txid = unsentTx?.txid ?? ''
      return [{ label: 'Proposal transaction', value: truncateAddress(txid), copyValue: txid }]
    }
    return [
      {
        label: 'Lender key',
        value: <KeyFingerprint fingerprint={draft.lender.fingerprint} name={draft.lender.name} />,
        tooltip: 'Compare it with the lender before you sign.',
      },
      { label: 'Collateral', value: formatCollateralDisplay(draft.collateralAmount) },
      { label: 'You receive', value: formatPrincipalAmount(draft.principalAmount) },
      { label: 'You repay', value: formatPrincipalAmount(draft.repaymentAmount) },
      {
        label: 'Interest',
        value: formatPrincipalAmount(draft.repaymentAmount - draft.principalAmount),
        tooltip: 'The repayment minus the principal.',
      },
      {
        label: 'Term ends at block',
        value: expiryLabel(draft.loanExpirationTime, 'pending', tipHeight),
      },
    ]
  }, [draft, unsentTx, formatCollateralDisplay, formatPrincipalAmount, tipHeight])

  const summary = useMemo(
    () =>
      draft
        ? [
            { label: 'Collateral', value: formatCollateralDisplay(draft.collateralAmount) },
            { label: 'You receive', value: formatPrincipalAmount(draft.principalAmount) },
            { label: 'You repay', value: formatPrincipalAmount(draft.repaymentAmount) },
          ]
        : [],
    [draft, formatCollateralDisplay, formatPrincipalAmount],
  )

  return (
    <PrivateTxShell
      isOpen={isOpen}
      title='Send your proposal'
      chip={
        <Chip color='warning' variant='soft' size='sm'>
          New
        </Chip>
      }
      label='Lock collateral and send'
      eyebrow='Lock collateral and send'
      summary={summary}
      unsentTx={unsentTx}
      execute={execute}
      onClose={onClose}
      onSuccess={onCreated}
      notice={
        <Notice>
          Only you and this lender key can read the proposal, and only it can accept: compare it
          with the lender before you sign. Your collateral stays locked until you repay the loan, or
          until you cancel the proposal before the lender accepts.
        </Notice>
      }
    >
      <DetailsPanel rows={rows} />
    </PrivateTxShell>
  )
}
