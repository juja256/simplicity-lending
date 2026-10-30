import { Chip } from '@heroui/react'
import { useMemo } from 'react'

import { useFormatAmount } from '@/hooks/useFormatAmount'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { buildPrivateCancellation } from '@/privateLending/flows/cancellation'
import { borrowerNftOutpoint } from '@/privateLending/offerView'
import { selectFeeCoins, walletReceiver } from '@/privateLending/wallet'
import { useWallet } from '@/providers/wallet/useWallet'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'
import { SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/script-auth/witness'

import PrivateOfferActionShell, {
  type FreshOffer,
  type PrivateOfferActionModalProps,
} from './PrivateOfferActionShell'

// The pending offer (OfferCancellation), the lender NFT at its script_auth lock, and the borrower
// NFT, a wallet output.
const CANCEL_WEIGHT_UNITS =
  PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.OfferCancellation +
  SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY +
  EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY

/** The borrower cancels a pending offer: both NFTs are burned and the collateral comes back. */
export default function CancelPrivateOfferModal(props: PrivateOfferActionModalProps) {
  const { item } = props
  const { terms } = item
  const { getReceiveAddress } = useWallet()
  const { formatCollateralDisplay } = useFormatAmount()

  // The indexer must still list the pending offer unspent (`requires`). The builder spends output
  // 3 and the lender NFT lock of the creation the gate verified, and requires the borrower NFT at
  // the outpoint given.
  const build = async ({ deps, offer, candidate }: FreshOffer) => {
    const feeCoins = selectFeeCoins(
      deps.walletUtxos(),
      deps.assets.policy,
      CANCEL_WEIGHT_UNITS,
      deps.feeRate,
    )
    return buildPrivateCancellation(deps, offer, {
      borrowerNftOutpoint: borrowerNftOutpoint(item.txid, candidate),
      feeCoins,
      collateralReceiver: await walletReceiver(deps, getReceiveAddress),
    })
  }

  const summary = useMemo(
    () => [
      { label: 'Collateral Returned', value: formatCollateralDisplay(terms.collateralAmount) },
    ],
    [terms, formatCollateralDisplay],
  )

  return (
    <PrivateOfferActionShell
      {...props}
      kind='private_cancel_offer'
      requires='pending_offer'
      title='Cancel Private Offer'
      chip={
        <Chip color='default' variant='soft' size='sm'>
          Cancel
        </Chip>
      }
      label='Cancel Offer'
      variant='danger-soft'
      eyebrow='Cancel Private Offer'
      summary={summary}
      build={build}
    />
  )
}
