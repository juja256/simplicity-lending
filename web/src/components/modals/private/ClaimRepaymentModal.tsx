import { Chip } from '@heroui/react'
import { useMemo } from 'react'

import { useFormatAmount } from '@/hooks/useFormatAmount'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { utxoOutpoint } from '@/privateLending/candidate'
import { buildFinalClaim, closedLoanOutpoint } from '@/privateLending/flows/claimRepayment'
import { loadLoan } from '@/privateLending/loan'
import { selectFeeCoins } from '@/privateLending/wallet'
import { useWallet } from '@/providers/wallet/useWallet'
import {
  ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY,
  ASSET_AUTH_MAX_WEIGHT_TO_SATISFY,
} from '@/simplicity/asset-auth/witness'
import { ACCEPTANCE_OUTPUT } from '@/simplicity/private-lending/layout'

import PrivateOfferActionShell, {
  type FreshOffer,
  type PrivateOfferActionModalProps,
} from './PrivateOfferActionShell'

/**
 * The lender claims the repayment of a repaid offer, burning its lender NFT, and sweeps the
 * installments it has not claimed with it.
 */
export default function ClaimRepaymentModal(props: PrivateOfferActionModalProps) {
  const { terms } = props.item
  const { getLendingKey } = useWallet()
  const { formatPrincipalAmount } = useFormatAmount()

  // `utxo` is the unspent repayment, output 1 of the full repayment. The outpoints come from the
  // indexer, read again now: the loan is read on chain from the output the repayment spent, and the
  // builder checks the rest on chain.
  const build = async ({ deps, offer, candidate, utxo }: FreshOffer) => {
    const loanOutpoint = await closedLoanOutpoint(deps, utxo.txid)
    const loan = await loadLoan(deps, offer, await getLendingKey(), loanOutpoint)
    const unspentInstallments = candidate.utxos
      .filter(installment => installment.utxo_type === 'installment')
      .filter(installment => installment.spent_txid === null)
      .map(utxoOutpoint)
    // The lender NFT, the repayment at its asset_auth (burn) and each installment at its own.
    const weightUnits =
      EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY +
      ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY +
      unspentInstallments.length * ASSET_AUTH_MAX_WEIGHT_TO_SATISFY
    const feeCoins = selectFeeCoins(
      deps.walletUtxos(),
      deps.assets.policy,
      weightUnits,
      deps.feeRate,
    )
    return buildFinalClaim(deps, offer, loan, {
      closeTxid: utxo.txid,
      unspentInstallments,
      // where the acceptance paid it: the app claims no installment before the final claim yet
      lenderNftOutpoint: `${loan.acceptanceTxid}:${ACCEPTANCE_OUTPUT.lenderNft}`,
      feeCoins,
    })
  }

  const summary = useMemo(
    () => [
      { label: 'Principal', value: formatPrincipalAmount(terms.principalAmount) },
      { label: 'Interest', value: formatPrincipalAmount(terms.interest) },
      { label: 'Total', value: formatPrincipalAmount(terms.repaymentAmount) },
    ],
    [terms, formatPrincipalAmount],
  )

  return (
    <PrivateOfferActionShell
      {...props}
      kind='private_claim_repayment'
      requires='repayment'
      title='Claim repayment'
      chip={
        <Chip color='accent' variant='soft' size='sm'>
          Claim
        </Chip>
      }
      label='Claim repayment'
      eyebrow='Claim repayment'
      summary={summary}
      build={build}
    />
  )
}
