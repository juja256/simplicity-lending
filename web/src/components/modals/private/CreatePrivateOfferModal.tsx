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
import { expiryLabel } from '@/privateLending/offerView'
import { selectCreationCoins, walletReceiver } from '@/privateLending/wallet'
import type { PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { useWallet } from '@/providers/wallet/useWallet'
import { truncateAddress } from '@/utils/format'

import PrivateTxShell from './PrivateTxShell'

/** A private offer as the borrower reviewed it. */
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
  /** A block height: the tip when the offer was reviewed, plus the blocks chosen. */
  loanExpirationTime: number
}

interface CreatePrivateOfferModalProps {
  isOpen: boolean
  /** The offer to create. Absent when the modal opens on a saved creation that was not sent. */
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
 * would be another offer.
 */
export default function CreatePrivateOfferModal({
  isOpen,
  draft,
  unsentTx,
  onClose,
  onCreated,
}: CreatePrivateOfferModalProps) {
  const { syncWallet, getLendingKey, getWalletTxOuts, getReceiveAddress } = useWallet()
  const getDeps = usePrivateFlowDeps()
  const { run } = usePrivateTransaction()
  const { data: tipHeight } = useBlockHeight()
  const { formatCollateralDisplay, formatPrincipalAmount } = useFormatAmount()

  const execute = async () => {
    if (!draft) throw new Error('There is no offer to create')
    return run({ kind: 'private_create_offer' }, async () => {
      await syncWallet()
      const [deps, borrower, tip] = await Promise.all([
        getDeps(),
        getLendingKey(),
        fetchLatestBlockHeight(),
      ])
      if (draft.lender.pubkey === borrower.xOnlyPublicKey()) {
        throw new Error('The lender is your own lending key')
      }
      if (draft.loanExpirationTime <= tip) {
        throw new Error(
          `The expiry, block #${draft.loanExpirationTime}, is no longer ahead of the chain ` +
            `(#${tip}). Review the offer again.`,
        )
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
        borrowerNftReceiver: await walletReceiver(deps, getReceiveAddress),
      })
    })
  }

  const rows = useMemo<DetailRow[]>(() => {
    if (!draft) {
      const txid = unsentTx?.txid ?? ''
      return [{ label: 'Offer Transaction', value: truncateAddress(txid), copyValue: txid }]
    }
    return [
      {
        label: 'Lender',
        value: <KeyFingerprint fingerprint={draft.lender.fingerprint} name={draft.lender.name} />,
      },
      { label: 'Collateral', value: formatCollateralDisplay(draft.collateralAmount) },
      { label: 'Principal', value: formatPrincipalAmount(draft.principalAmount) },
      { label: 'Repayment', value: formatPrincipalAmount(draft.repaymentAmount) },
      {
        label: 'Interest',
        value: formatPrincipalAmount(draft.repaymentAmount - draft.principalAmount),
        tooltip: 'The repayment minus the principal.',
      },
      {
        label: 'Expiry Block',
        value: expiryLabel(draft.loanExpirationTime, 'pending', tipHeight),
      },
    ]
  }, [draft, unsentTx, formatCollateralDisplay, formatPrincipalAmount, tipHeight])

  const summary = useMemo(
    () =>
      draft
        ? [
            { label: 'Collateral', value: formatCollateralDisplay(draft.collateralAmount) },
            { label: 'Borrow', value: formatPrincipalAmount(draft.principalAmount) },
            { label: 'Repayment', value: formatPrincipalAmount(draft.repaymentAmount) },
          ]
        : [],
    [draft, formatCollateralDisplay, formatPrincipalAmount],
  )

  return (
    <PrivateTxShell
      isOpen={isOpen}
      title='Create Private Offer'
      chip={
        <Chip color='warning' variant='soft' size='sm'>
          New
        </Chip>
      }
      label='Sign & Create Offer'
      eyebrow='New Private Offer'
      summary={summary}
      unsentTx={unsentTx}
      execute={execute}
      onClose={onClose}
      onSuccess={onCreated}
      notice={
        <Notice>
          Only this lending key can read the offer and accept it: compare the fingerprint with the
          lender before you sign. Your collateral stays locked until you repay the loan or cancel
          the offer.
        </Notice>
      }
    >
      <DetailsPanel rows={rows} />
    </PrivateTxShell>
  )
}
