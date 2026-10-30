import { Chip } from '@heroui/react'
import { useMemo } from 'react'

import { fetchPrivateCandidate } from '@/api/indexer/private'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { acceptanceTxid, outpointOf, unspentUtxo } from '@/pages/Private/helpers'
import type { PrivateFlowDeps } from '@/privateLending/deps'
import { buildRepaymentClaim } from '@/privateLending/flows/claimRepayment'
import { PRIVATE_API_BASE_URL } from '@/privateLending/hooks/usePrivateFlowDeps'
import type { VerifiedOffer } from '@/privateLending/verify'
import { useWallet } from '@/providers/wallet/useWallet'
import { ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/asset-auth/witness'
import { ACCEPTANCE_OUTPUT } from '@/simplicity/private-lending/layout'

import PrivateOfferActionShell, {
  type PrivateOfferActionModalProps,
} from './PrivateOfferActionShell'
import { selectFeeCoins } from './walletCoins'

// The repayment at its asset_auth (burning the lender NFT), and the lender NFT, a wallet output.
const CLAIM_WEIGHT_UNITS =
  ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY + EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY

/** The lender claims the repayment of a repaid offer, burning its lender NFT. */
export default function ClaimRepaymentModal(props: PrivateOfferActionModalProps) {
  const { item } = props
  const { terms } = item
  const { getReceiveAddress } = useWallet()
  const { formatPrincipalAmount } = useFormatAmount()

  const build = async (deps: PrivateFlowDeps, offer: VerifiedOffer) => {
    // The outpoints come from the indexer, read again now; the builder checks both on chain.
    const candidate = await fetchPrivateCandidate(item.txid, PRIVATE_API_BASE_URL)
    const repayment = unspentUtxo(candidate, 'repayment')
    if (!repayment) throw new Error('The indexer lists no unspent repayment for this offer')
    const acceptance = acceptanceTxid(candidate)
    if (!acceptance) throw new Error('The indexer lists no acceptance for this offer')
    const feeCoins = selectFeeCoins(
      deps.walletUtxos(),
      deps.assets.policy,
      CLAIM_WEIGHT_UNITS,
      deps.feeRate,
    )
    const receiveAddress = await getReceiveAddress()
    if (!receiveAddress) throw new Error('Missing wallet receive address')
    return buildRepaymentClaim(deps, offer, {
      repaymentOutpoint: outpointOf(repayment),
      lenderNftOutpoint: `${acceptance}:${ACCEPTANCE_OUTPUT.lenderNft}`,
      feeCoins,
      receiver: deps.lwk.Address.parse(receiveAddress, deps.network),
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
