import { Chip } from '@heroui/react'
import { useMemo } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import Notice from '@/components/Notice'
import { NETWORK_CONFIG } from '@/constants/network-config'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { repaymentBorrowerNftOutpoint, utxoOutpoint } from '@/privateLending/candidate'
import { buildPrivateRepayment } from '@/privateLending/flows/repayment'
import { isPastExpiry } from '@/privateLending/offerView'
import { selectAssetCoins, selectFeeCoins, walletReceiver } from '@/privateLending/wallet'
import { useWallet } from '@/providers/wallet/useWallet'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'

import PrivateOfferActionShell, {
  type FreshOffer,
  type PrivateOfferActionModalProps,
} from './PrivateOfferActionShell'

// The active offer (FullRepayment), and the borrower NFT, a wallet output.
const REPAY_WEIGHT_UNITS =
  PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.FullRepayment + EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY

/**
 * The borrower repays an accepted loan in full: it burns the borrower NFT, pays the repayment to
 * the lender, and takes its collateral back.
 */
export default function RepayPrivateOfferModal(props: PrivateOfferActionModalProps) {
  const { item } = props
  const { terms } = item
  const { principalAsset } = NETWORK_CONFIG
  const { getReceiveAddress, confirmedBalances } = useWallet()
  const { data: tipHeight } = useBlockHeight()
  const { formatCollateralDisplay, formatPrincipalAmount } = useFormatAmount()

  const insufficientBalance =
    BigInt(confirmedBalances[principalAsset.id] ?? 0) < terms.repaymentAmount
  const isExpired = isPastExpiry(terms, tipHeight)

  // `utxo` is the unspent active offer. The outpoints come from the indexer, read again now; the
  // builder checks that the active offer is this offer's, and on chain that the borrower NFT is
  // output 0 of a transaction that claimed this offer's principal.
  const build = async ({ deps, offer, candidate, utxo }: FreshOffer) => {
    // The repayment burns the borrower NFT, the only key to an unclaimed principal: it needs the
    // indexer's evidence of the claim, and never falls back to the NFT where the creation put it.
    const borrowerNft = repaymentBorrowerNftOutpoint(item.txid, candidate)
    if (borrowerNft === undefined) {
      throw new Error(
        'The indexer lists no claim of the principal. Claim it first: the repayment burns the ' +
          'borrower NFT, which unlocks it.',
      )
    }
    if (offer.opened.principalAsset() !== principalAsset.id) {
      throw new Error(`The offer's principal is not ${principalAsset.symbol}`)
    }
    const coins = deps.walletUtxos()
    const principalCoins = selectAssetCoins(
      coins,
      principalAsset.id,
      offer.opened.repaymentAmount(),
      principalAsset.symbol,
    )
    const feeCoins = selectFeeCoins(
      coins,
      deps.assets.policy,
      REPAY_WEIGHT_UNITS,
      deps.feeRate,
      principalCoins,
    )
    return buildPrivateRepayment(deps, offer, {
      activeOfferOutpoint: utxoOutpoint(utxo),
      borrowerNftOutpoint: borrowerNft,
      principalCoins,
      feeCoins,
      collateralReceiver: await walletReceiver(deps, getReceiveAddress),
    })
  }

  const summary = useMemo(
    () => [
      { label: 'Principal', value: formatPrincipalAmount(terms.principalAmount) },
      { label: 'Interest', value: formatPrincipalAmount(terms.interest) },
      { label: 'Total Repaid', value: formatPrincipalAmount(terms.repaymentAmount) },
      { label: 'Collateral Returned', value: formatCollateralDisplay(terms.collateralAmount) },
    ],
    [terms, formatCollateralDisplay, formatPrincipalAmount],
  )

  return (
    <PrivateOfferActionShell
      {...props}
      kind='private_repay_offer'
      requires='active_offer'
      title='Repay Private Loan'
      chip={
        <Chip color='success' variant='soft' size='sm'>
          Repay
        </Chip>
      }
      label='Repay & Unlock Collateral'
      eyebrow='Repay Private Loan'
      summary={summary}
      disabled={insufficientBalance}
      notice={
        insufficientBalance ? (
          <Notice>
            Insufficient confirmed {principalAsset.symbol} balance: the repayment is{' '}
            {formatPrincipalAmount(terms.repaymentAmount)}.
          </Notice>
        ) : (
          isExpired && (
            <Notice>
              The loan expired at block #{terms.loanExpirationTime}. The lender may liquidate it at
              any time; until then you can still repay it.
            </Notice>
          )
        )
      }
      build={build}
    />
  )
}
