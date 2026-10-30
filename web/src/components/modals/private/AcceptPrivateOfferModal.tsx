import { useMemo } from 'react'

import Notice from '@/components/Notice'
import { OfferStatusChip } from '@/components/OfferStatusChip'
import { NETWORK_CONFIG } from '@/constants/network-config'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { buildPrivateAcceptance } from '@/privateLending/flows/acceptance'
import { selectAssetCoins, selectFeeCoins, walletReceiver } from '@/privateLending/wallet'
import { useWallet } from '@/providers/wallet/useWallet'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'
import { SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/script-auth/witness'

import PrivateOfferActionShell, {
  type FreshOffer,
  type PrivateOfferActionModalProps,
} from './PrivateOfferActionShell'

// The covenant inputs: the pending offer and the lender NFT at its script_auth lock.
const ACCEPT_WEIGHT_UNITS =
  PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.OfferAcceptance + SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY

/**
 * The lender accepts a pending offer: it pays the principal, locked to the borrower NFT, and
 * receives the lender NFT at its wallet address.
 */
export default function AcceptPrivateOfferModal(props: PrivateOfferActionModalProps) {
  const { terms } = props.item
  const { principalAsset } = NETWORK_CONFIG
  const { getReceiveAddress, confirmedBalances } = useWallet()
  const { formatCollateralDisplay, formatPrincipalAmount } = useFormatAmount()

  const insufficientBalance =
    BigInt(confirmedBalances[principalAsset.id] ?? 0) < terms.principalAmount

  // The indexer must still list the pending offer unspent (`requires`); the builder spends output
  // 3 of the creation the gate verified.
  const build = async ({ deps, offer }: FreshOffer) => {
    if (offer.opened.principalAsset() !== principalAsset.id) {
      throw new Error(`The offer's principal is not ${principalAsset.symbol}`)
    }
    const coins = deps.walletUtxos()
    const principalCoins = selectAssetCoins(
      coins,
      principalAsset.id,
      offer.opened.principalAmount(),
      principalAsset.symbol,
    )
    const feeCoins = selectFeeCoins(
      coins,
      deps.assets.policy,
      ACCEPT_WEIGHT_UNITS,
      deps.feeRate,
      principalCoins,
    )
    return buildPrivateAcceptance(deps, offer, {
      principalCoins,
      feeCoins,
      lenderNftReceiver: await walletReceiver(deps, getReceiveAddress),
    })
  }

  const summary = useMemo(
    () => [
      { label: 'Collateral', value: formatCollateralDisplay(terms.collateralAmount) },
      { label: 'Principal Supplied', value: formatPrincipalAmount(terms.principalAmount) },
      { label: 'Repayment', value: formatPrincipalAmount(terms.repaymentAmount) },
      { label: 'Earn', value: formatPrincipalAmount(terms.interest) },
      { label: 'Expiration Block', value: `#${terms.loanExpirationTime}` },
    ],
    [terms, formatCollateralDisplay, formatPrincipalAmount],
  )

  return (
    <PrivateOfferActionShell
      {...props}
      kind='private_accept_offer'
      requires='pending_offer'
      title='Accept Private Offer'
      chip={<OfferStatusChip status='pending' />}
      label='Accept & Supply'
      eyebrow='Accept Private Offer'
      summary={summary}
      disabled={insufficientBalance}
      notice={
        insufficientBalance && (
          <Notice>
            Insufficient confirmed {principalAsset.symbol} balance to accept this offer.
          </Notice>
        )
      }
      build={build}
    />
  )
}
