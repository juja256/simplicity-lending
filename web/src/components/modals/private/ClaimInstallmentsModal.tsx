import { Chip } from '@heroui/react'
import { useMemo } from 'react'

import { useFormatAmount } from '@/hooks/useFormatAmount'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { utxoOutpoint } from '@/privateLending/candidate'
import {
  buildInstallmentClaim,
  findLenderNft,
  openedInstallmentAmounts,
} from '@/privateLending/flows/claimInstallments'
import { useLoan } from '@/privateLending/hooks/useLoan'
import { esploraSpentBy } from '@/privateLending/hooks/usePrivateFlowDeps'
import { loadLoan } from '@/privateLending/loan'
import { claimableInstallments } from '@/privateLending/offerView'
import { selectFeeCoins } from '@/privateLending/wallet'
import { useWallet } from '@/providers/wallet/useWallet'
import { ASSET_AUTH_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/asset-auth/witness'

import PrivateOfferActionShell, {
  type FreshOffer,
  type PrivateOfferActionModalProps,
} from './PrivateOfferActionShell'

/**
 * The lender claims the installments the borrower paid on an active loan, those that open with its
 * key: the lender NFT unlocks them and comes back to the wallet. An installment that does not
 * open is left for the final claim, which sweeps it once the loan closes.
 */
export default function ClaimInstallmentsModal(props: PrivateOfferActionModalProps) {
  const { item } = props
  const { getLendingKey } = useWallet()
  const { formatPrincipalAmount } = useFormatAmount()
  const { data: loan } = useLoan(item)

  // `utxo` is the unspent loan output. The outpoints come from the indexer, read again now: the
  // loan is walked back on chain to this offer's acceptance, the lender NFT found by walking
  // forward from it, and the builder checks every installment and the NFT on chain.
  const build = async ({ deps, offer, candidate, utxo }: FreshOffer) => {
    const fresh = await loadLoan(deps, offer, await getLendingKey(), utxoOutpoint(utxo))
    const opened = openedInstallmentAmounts(fresh)
    const installments = candidate.utxos
      .filter(installment => installment.utxo_type === 'installment')
      .filter(installment => installment.spent_txid === null)
      .map(utxoOutpoint)
      .filter(outpoint => opened.has(outpoint))
    if (installments.length === 0) {
      throw new Error('The indexer lists no unclaimed installment that opens with your key')
    }
    const lenderNftOutpoint = await findLenderNft(deps, offer, fresh, esploraSpentBy)
    // The lender NFT, and each installment at its asset_auth (no burn).
    const feeCoins = selectFeeCoins(
      deps.walletUtxos(),
      deps.assets.policy,
      EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY +
        installments.length * ASSET_AUTH_MAX_WEIGHT_TO_SATISFY,
      deps.feeRate,
    )
    return buildInstallmentClaim(deps, offer, fresh, {
      installments,
      lenderNftOutpoint,
      feeCoins,
    })
  }

  const summary = useMemo(() => {
    const claimable = claimableInstallments(item.candidate, loan)
    if (claimable.length === 0) return []
    const total = claimable.reduce((sum, { amount }) => sum + amount, 0n)
    return [
      { label: 'Installments', value: String(claimable.length) },
      { label: 'You claim', value: formatPrincipalAmount(total) },
    ]
  }, [item.candidate, loan, formatPrincipalAmount])

  return (
    <PrivateOfferActionShell
      {...props}
      kind='private_claim_installments'
      requires='active_offer'
      title='Claim installments'
      chip={
        <Chip color='success' variant='soft' size='sm'>
          Active
        </Chip>
      }
      label='Claim installments'
      eyebrow='Claim installments'
      summary={summary}
      build={build}
    />
  )
}
