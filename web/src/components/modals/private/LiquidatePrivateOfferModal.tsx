import { Chip } from '@heroui/react'
import { useMemo } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import { fetchLatestBlockHeight } from '@/api/esplora/methods'
import { fetchPrivateCandidate } from '@/api/indexer/private'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { isPastExpiry, outpointOf, unspentUtxo } from '@/pages/Private/helpers'
import type { PrivateFlowDeps } from '@/privateLending/deps'
import { buildPrivateLiquidation } from '@/privateLending/flows/liquidation'
import { PRIVATE_API_BASE_URL } from '@/privateLending/hooks/usePrivateFlowDeps'
import type { VerifiedOffer } from '@/privateLending/verify'
import { useWallet } from '@/providers/wallet/useWallet'
import { ACCEPTANCE_OUTPUT } from '@/simplicity/private-lending/layout'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'

import PrivateOfferActionShell, {
  type PrivateOfferActionModalProps,
} from './PrivateOfferActionShell'
import { selectFeeCoins } from './walletCoins'

// The active offer (Liquidation), and the lender NFT, a wallet output.
const LIQUIDATE_WEIGHT_UNITS =
  PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.Liquidation + EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY

/** The lender takes the collateral of an expired loan, burning its lender NFT. */
export default function LiquidatePrivateOfferModal(props: PrivateOfferActionModalProps) {
  const { item } = props
  const { terms } = item
  const { getReceiveAddress } = useWallet()
  const { data: tipHeight } = useBlockHeight()
  const { formatCollateralDisplay } = useFormatAmount()
  const isExpired = isPastExpiry(terms, tipHeight)

  const build = async (deps: PrivateFlowDeps, offer: VerifiedOffer) => {
    // The outpoints come from the indexer, read again now; the builder checks both on chain. It
    // also refuses, before anything else, while the tip is below the expiry.
    const [candidate, currentTip] = await Promise.all([
      fetchPrivateCandidate(item.txid, PRIVATE_API_BASE_URL),
      fetchLatestBlockHeight(),
    ])
    const activeOffer = unspentUtxo(candidate, 'active_offer')
    if (!activeOffer) throw new Error('The indexer lists no unspent active offer for this offer')
    const feeCoins = selectFeeCoins(
      deps.walletUtxos(),
      deps.assets.policy,
      LIQUIDATE_WEIGHT_UNITS,
      deps.feeRate,
    )
    const receiveAddress = await getReceiveAddress()
    if (!receiveAddress) throw new Error('Missing wallet receive address')
    return buildPrivateLiquidation(deps, offer, {
      activeOfferOutpoint: outpointOf(activeOffer),
      // The acceptance created the active offer and paid the lender NFT in the same transaction.
      lenderNftOutpoint: `${activeOffer.txid}:${ACCEPTANCE_OUTPUT.lenderNft}`,
      feeCoins,
      collateralReceiver: deps.lwk.Address.parse(receiveAddress, deps.network),
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
          <div className='border-warning/30 bg-warning/10 text-warning rounded-2xl border px-4 py-3 text-sm'>
            The loan expires at block #{terms.loanExpirationTime}. It can be liquidated once the
            chain is past it.
          </div>
        )
      }
      build={build}
    />
  )
}
