import { Chip } from '@heroui/react'
import { useMemo } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import { fetchLatestBlockHeight } from '@/api/esplora/methods'
import Notice from '@/components/Notice'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { utxoOutpoint } from '@/privateLending/candidate'
import { buildPrivateLiquidation } from '@/privateLending/flows/liquidation'
import { isPastExpiry } from '@/privateLending/offerView'
import { selectFeeCoins, walletReceiver } from '@/privateLending/wallet'
import { useWallet } from '@/providers/wallet/useWallet'
import { ACCEPTANCE_OUTPUT } from '@/simplicity/private-lending/layout'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'

import PrivateOfferActionShell, {
  type FreshOffer,
  type PrivateOfferActionModalProps,
} from './PrivateOfferActionShell'

// The active offer (Liquidation), and the lender NFT, a wallet output.
const LIQUIDATE_WEIGHT_UNITS =
  PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.Liquidation + EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY

/** The lender takes the collateral of an expired loan, burning its lender NFT. */
export default function LiquidatePrivateOfferModal(props: PrivateOfferActionModalProps) {
  const { terms } = props.item
  const { getReceiveAddress } = useWallet()
  const { data: tipHeight } = useBlockHeight()
  const { formatCollateralDisplay } = useFormatAmount()
  const isExpired = isPastExpiry(terms, tipHeight)

  // `utxo` is the unspent active offer. The outpoints come from the indexer, read again now; the
  // builder checks both on chain. It also refuses, before anything else, while the tip is below
  // the expiry.
  const build = async ({ deps, offer, utxo }: FreshOffer) => {
    const currentTip = await fetchLatestBlockHeight()
    const feeCoins = selectFeeCoins(
      deps.walletUtxos(),
      deps.assets.policy,
      LIQUIDATE_WEIGHT_UNITS,
      deps.feeRate,
    )
    return buildPrivateLiquidation(deps, offer, {
      activeOfferOutpoint: utxoOutpoint(utxo),
      // The acceptance created the active offer and paid the lender NFT in the same transaction.
      lenderNftOutpoint: `${utxo.txid}:${ACCEPTANCE_OUTPUT.lenderNft}`,
      feeCoins,
      collateralReceiver: await walletReceiver(deps, getReceiveAddress),
      tipHeight: currentTip,
    })
  }

  const summary = useMemo(
    () => [
      { label: 'Collateral', value: formatCollateralDisplay(terms.collateralAmount) },
      { label: 'Expiration Block', value: `#${terms.loanExpirationTime}` },
    ],
    [terms, formatCollateralDisplay],
  )

  return (
    <PrivateOfferActionShell
      {...props}
      kind='private_liquidate_offer'
      requires='active_offer'
      title='Liquidate Private Offer'
      chip={
        <Chip color='danger' variant='soft' size='sm'>
          Liquidate
        </Chip>
      }
      label='Liquidate & Claim Collateral'
      variant='danger-soft'
      eyebrow='Liquidate Private Offer'
      summary={summary}
      disabled={!isExpired}
      notice={
        !isExpired && (
          <Notice>
            The loan expires at block #{terms.loanExpirationTime}. It can be liquidated once the
            chain is past it.
          </Notice>
        )
      }
      build={build}
    />
  )
}
