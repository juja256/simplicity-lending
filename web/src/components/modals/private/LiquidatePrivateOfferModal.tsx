import { Chip } from '@heroui/react'
import { useMemo } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import { fetchLatestBlockHeight } from '@/api/esplora/methods'
import Notice from '@/components/Notice'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { utxoOutpoint } from '@/privateLending/candidate'
import { findCollateralInWorker } from '@/privateLending/collateralSearch'
import { findLenderNft } from '@/privateLending/flows/claimInstallments'
import { buildPrivateLiquidation } from '@/privateLending/flows/liquidation'
import { esploraSpentBy } from '@/privateLending/hooks/usePrivateFlowDeps'
import { loadLoan } from '@/privateLending/loan'
import { isPastExpiry } from '@/privateLending/offerView'
import { selectFeeCoins, walletReceiver } from '@/privateLending/wallet'
import { useWallet } from '@/providers/wallet/useWallet'
import { ASSET_AUTH_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/asset-auth/witness'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'

import PrivateOfferActionShell, {
  type FreshOffer,
  type PrivateOfferActionModalProps,
} from './PrivateOfferActionShell'

// The active offer (Liquidation), and the lender NFT, a wallet output.
const LIQUIDATE_WEIGHT_UNITS =
  PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.Liquidation + EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY

/**
 * The lender takes the collateral of an expired loan, burning its lender NFT, and sweeps the
 * installments it has not claimed that open with its key.
 */
export default function LiquidatePrivateOfferModal(props: PrivateOfferActionModalProps) {
  const { terms } = props.item
  const { getLendingKey } = useWallet()
  const { data: tipHeight } = useBlockHeight()
  const { formatCollateralDisplay } = useFormatAmount()
  const isExpired = isPastExpiry(terms, tipHeight)
  const notYet =
    `The loan expires at block #${terms.loanExpirationTime}. It can be liquidated once the ` +
    'chain is past it.'

  // `utxo` is the unspent loan output. The outpoints come from the indexer, read again now:
  // `loadLoan` walks the loan back on chain to this offer's acceptance, the lender NFT is found by
  // walking forward from it, and the builder checks the rest on chain. A tip below the expiry is
  // refused first, before the loan is read, so that a failed read cannot hide why; the builder
  // refuses it too.
  const build = async ({ deps, offer, candidate, utxo }: FreshOffer) => {
    const currentTip = await fetchLatestBlockHeight()
    if (currentTip < terms.loanExpirationTime) throw new Error(notYet)
    const loan = await loadLoan(deps, offer, await getLendingKey(), utxoOutpoint(utxo))
    const unspentInstallments = candidate.utxos
      .filter(installment => installment.utxo_type === 'installment')
      .filter(installment => installment.spent_txid === null)
      .map(utxoOutpoint)
    const feeCoins = selectFeeCoins(
      deps.walletUtxos(),
      deps.assets.policy,
      LIQUIDATE_WEIGHT_UNITS + unspentInstallments.length * ASSET_AUTH_MAX_WEIGHT_TO_SATISFY,
      deps.feeRate,
    )
    return buildPrivateLiquidation(deps, offer, loan, {
      lenderNftOutpoint: await findLenderNft(deps, offer, loan, esploraSpentBy),
      unspentInstallments,
      feeCoins,
      collateralReceiver: walletReceiver(deps),
      tipHeight: currentTip,
      // when an installment does not open for the lender: off the page's thread
      findCollateral: findCollateralInWorker,
    })
  }

  const summary = useMemo(
    () => [
      { label: 'Collateral', value: formatCollateralDisplay(terms.collateralAmount) },
      { label: 'Expiration block', value: `#${terms.loanExpirationTime}` },
    ],
    [terms, formatCollateralDisplay],
  )

  return (
    <PrivateOfferActionShell
      {...props}
      kind='private_liquidate_offer'
      requires='active_offer'
      title='Liquidate private offer'
      chip={
        <Chip color='danger' variant='soft' size='sm'>
          Liquidate
        </Chip>
      }
      label='Liquidate and claim collateral'
      variant='danger-soft'
      eyebrow='Liquidate private offer'
      summary={summary}
      disabled={!isExpired}
      notice={!isExpired && <Notice>{notYet}</Notice>}
      build={build}
    />
  )
}
