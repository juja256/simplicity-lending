import { Chip } from '@heroui/react'
import { useMemo } from 'react'

import { useFormatAmount } from '@/hooks/useFormatAmount'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { acceptanceTxid, utxoOutpoint } from '@/privateLending/candidate'
import { buildRepaymentClaim } from '@/privateLending/flows/claimRepayment'
import { selectFeeCoins, walletReceiver } from '@/privateLending/wallet'
import { useWallet } from '@/providers/wallet/useWallet'
import { ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/asset-auth/witness'
import { ACCEPTANCE_OUTPUT } from '@/simplicity/private-lending/layout'

import PrivateOfferActionShell, {
  type FreshOffer,
  type PrivateOfferActionModalProps,
} from './PrivateOfferActionShell'

// The repayment at its asset_auth (burning the lender NFT), and the lender NFT, a wallet output.
const CLAIM_WEIGHT_UNITS =
  ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY + EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY

/** The lender claims the repayment of a repaid offer, burning its lender NFT. */
export default function ClaimRepaymentModal(props: PrivateOfferActionModalProps) {
  const { terms } = props.item
  const { getReceiveAddress } = useWallet()
  const { formatPrincipalAmount } = useFormatAmount()

  // `utxo` is the unspent repayment. The outpoints come from the indexer, read again now; the
  // builder checks both on chain.
  const build = async ({ deps, offer, candidate, utxo }: FreshOffer) => {
    const acceptance = acceptanceTxid(candidate)
    if (!acceptance) throw new Error('The indexer lists no acceptance for this offer')
    const feeCoins = selectFeeCoins(
      deps.walletUtxos(),
      deps.assets.policy,
      CLAIM_WEIGHT_UNITS,
      deps.feeRate,
    )
    return buildRepaymentClaim(deps, offer, {
      repaymentOutpoint: utxoOutpoint(utxo),
      lenderNftOutpoint: `${acceptance}:${ACCEPTANCE_OUTPUT.lenderNft}`,
      feeCoins,
      receiver: await walletReceiver(deps, getReceiveAddress),
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
      title='Claim Repayment'
      chip={
        <Chip color='accent' variant='soft' size='sm'>
          Claim
        </Chip>
      }
      label='Claim Repayment'
      eyebrow='Claim Repayment'
      summary={summary}
      build={build}
    />
  )
}
