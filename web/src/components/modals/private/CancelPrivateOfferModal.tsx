import { Chip } from '@heroui/react'
import { useMemo } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { borrowerNftOutpoint } from '@/privateLending/candidate'
import { buildPrivateCancellation } from '@/privateLending/flows/cancellation'
import { canStillAccept } from '@/privateLending/offerView'
import { selectFeeCoins, walletReceiver } from '@/privateLending/wallet'
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

/**
 * The borrower cancels a pending offer: both NFTs are burned and the collateral comes back. It
 * shows in the borrower's words: a proposal, cancelled to take the collateral back.
 */
export default function CancelPrivateOfferModal(props: PrivateOfferActionModalProps) {
  const { item } = props
  const { terms } = item
  const { formatCollateralDisplay } = useFormatAmount()
  const { data: tipHeight } = useBlockHeight()
  // Past its term the lender can no longer accept it: it expired.
  const expired = tipHeight > 0 && !canStillAccept(terms, tipHeight)

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
      collateralReceiver: walletReceiver(deps),
    })
  }

  const summary = useMemo(
    () => [
      { label: 'Collateral back to you', value: formatCollateralDisplay(terms.collateralAmount) },
    ],
    [terms, formatCollateralDisplay],
  )

  return (
    <PrivateOfferActionShell
      {...props}
      kind='private_cancel_offer'
      requires='pending_offer'
      title='Cancel your proposal'
      chip={
        <Chip color={expired ? 'default' : 'warning'} variant='soft' size='sm'>
          {expired ? 'Expired' : 'Not accepted yet'}
        </Chip>
      }
      label='Cancel proposal'
      variant='danger-soft'
      eyebrow='Cancel proposal'
      summary={summary}
      build={build}
    />
  )
}
