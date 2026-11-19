import { Chip } from '@heroui/react'
import { useMemo } from 'react'

import { loanBookFigures } from '@/areas/lend/bookSummary'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { closedLoanUtxo, unspentUtxo, utxoOutpoint } from '@/privateLending/candidate'
import { findLenderNft } from '@/privateLending/flows/claimInstallments'
import { buildFinalClaim, closedLoanOutpoint } from '@/privateLending/flows/claimRepayment'
import { useLoan } from '@/privateLending/hooks/useLoan'
import { esploraSpentBy } from '@/privateLending/hooks/usePrivateFlowDeps'
import { loadLoan } from '@/privateLending/loan'
import { selectFeeCoins } from '@/privateLending/wallet'
import { useWallet } from '@/providers/wallet/useWallet'
import {
  ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY,
  ASSET_AUTH_MAX_WEIGHT_TO_SATISFY,
} from '@/simplicity/asset-auth/witness'

import PrivateOfferActionShell, {
  type FreshOffer,
  type PrivateOfferActionModalProps,
  type RequiredUtxo,
} from './PrivateOfferActionShell'

/** The closed loan output: the full repayment and the zero-debt close both spend it. */
const CLOSED_LOAN: RequiredUtxo = {
  find: closedLoanUtxo,
  missing: 'The indexer lists no close of this loan: it may have changed since the page loaded.',
}

/**
 * The lender's final claim of a loan the borrower closed, by the full repayment or the zero-debt
 * close: it sweeps the repayment, if any, with every installment the lender has not claimed, and
 * burns the lender NFT.
 */
export default function ClaimRepaymentModal(props: PrivateOfferActionModalProps) {
  const { item } = props
  const { terms } = item
  const { getLendingKey } = useWallet()
  const { formatPrincipalAmount } = useFormatAmount()
  const { data: loan } = useLoan(item)

  // `utxo` is the last loan output, which the close spent. The outpoints come from the indexer,
  // read again now: the loan is read on chain from the output the close spends at input 1, the
  // lender NFT found by walking forward from the acceptance, and the builder checks the rest.
  const build = async ({ deps, offer, candidate, utxo }: FreshOffer) => {
    const closeTxid = utxo.spent_txid
    if (closeTxid === null) throw new Error('The indexer lists the loan as not closed')
    const loanOutpoint = await closedLoanOutpoint(deps, closeTxid)
    const fresh = await loadLoan(deps, offer, await getLendingKey(), loanOutpoint)
    const unspentInstallments = candidate.utxos
      .filter(installment => installment.utxo_type === 'installment')
      .filter(installment => installment.spent_txid === null)
      .map(utxoOutpoint)
    const lenderNftOutpoint = await findLenderNft(deps, offer, fresh, esploraSpentBy)
    // The lender NFT, the repayment at its asset_auth (burn) after a full repayment, and each
    // installment at its own.
    const repaymentWeight =
      unspentUtxo(candidate, 'repayment') === undefined ? 0 : ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY
    const weightUnits =
      EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY +
      repaymentWeight +
      unspentInstallments.length * ASSET_AUTH_MAX_WEIGHT_TO_SATISFY
    const feeCoins = selectFeeCoins(
      deps.walletUtxos(),
      deps.assets.policy,
      weightUnits,
      deps.feeRate,
    )
    return buildFinalClaim(deps, offer, fresh, {
      closeTxid,
      unspentInstallments,
      lenderNftOutpoint,
      feeCoins,
    })
  }

  const summary = useMemo(() => {
    const figures = loanBookFigures(item, loan)
    return [
      { label: 'Repayment', value: formatPrincipalAmount(terms.repaymentAmount) },
      {
        label: 'You claim now',
        value:
          figures === null || figures.unknownClaimable > 0
            ? 'The rest of the repayment'
            : formatPrincipalAmount(figures.claimable),
      },
    ]
  }, [item, loan, terms, formatPrincipalAmount])

  return (
    <PrivateOfferActionShell
      {...props}
      kind='private_claim_repayment'
      requires={CLOSED_LOAN}
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
