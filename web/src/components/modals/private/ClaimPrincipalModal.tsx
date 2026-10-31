import { Chip } from '@heroui/react'
import { useMemo } from 'react'

import { useFormatAmount } from '@/hooks/useFormatAmount'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { borrowerNftOutpoint, utxoOutpoint } from '@/privateLending/candidate'
import { buildPrincipalClaim } from '@/privateLending/flows/claimPrincipal'
import { selectFeeCoins, walletReceiver } from '@/privateLending/wallet'
import { useWallet } from '@/providers/wallet/useWallet'
import { ASSET_AUTH_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/asset-auth/witness'

import PrivateOfferActionShell, {
  type FreshOffer,
  type PrivateOfferActionModalProps,
} from './PrivateOfferActionShell'

// The principal at its asset_auth (no burn), and the borrower NFT, a wallet output.
const CLAIM_WEIGHT_UNITS =
  ASSET_AUTH_MAX_WEIGHT_TO_SATISFY + EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY

/**
 * The borrower claims the principal the lender paid at acceptance. The borrower NFT unlocks it and
 * comes back to the wallet.
 */
export default function ClaimPrincipalModal(props: PrivateOfferActionModalProps) {
  const { item } = props
  const { terms } = item
  const { getReceiveAddress } = useWallet()
  const { formatPrincipalAmount } = useFormatAmount()

  // `utxo` is the unspent principal. The outpoints come from the indexer, read again now; the
  // builder checks that the principal is this offer's and that the borrower NFT is at its outpoint.
  const build = async ({ deps, offer, candidate, utxo }: FreshOffer) => {
    const feeCoins = selectFeeCoins(
      deps.walletUtxos(),
      deps.assets.policy,
      CLAIM_WEIGHT_UNITS,
      deps.feeRate,
    )
    return buildPrincipalClaim(deps, offer, {
      principalOutpoint: utxoOutpoint(utxo),
      borrowerNftOutpoint: borrowerNftOutpoint(item.txid, candidate),
      feeCoins,
      receiver: await walletReceiver(deps, getReceiveAddress),
    })
  }

  const summary = useMemo(
    () => [{ label: 'Principal', value: formatPrincipalAmount(terms.principalAmount) }],
    [terms, formatPrincipalAmount],
  )

  return (
    <PrivateOfferActionShell
      {...props}
      kind='private_claim_principal'
      requires='principal'
      title='Claim Principal'
      chip={
        <Chip color='accent' variant='soft' size='sm'>
          Claim
        </Chip>
      }
      label='Claim Principal'
      eyebrow='Claim Principal'
      summary={summary}
      build={build}
    />
  )
}
