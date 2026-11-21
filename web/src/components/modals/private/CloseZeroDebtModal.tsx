import { Chip } from '@heroui/react'
import { useMemo } from 'react'

import { useFormatAmount } from '@/hooks/useFormatAmount'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { asBorrowerError } from '@/privateLending/borrowerErrors'
import { loanBorrowerNftOutpoint, utxoOutpoint } from '@/privateLending/candidate'
import { buildZeroDebtClose } from '@/privateLending/flows/zeroDebtClose'
import { loadLoan } from '@/privateLending/loan'
import { borrowerActions } from '@/privateLending/offerView'
import { selectFeeCoins, walletReceiver } from '@/privateLending/wallet'
import { useWallet } from '@/providers/wallet/useWallet'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'

import PrivateOfferActionShell, {
  type FreshOffer,
  type PrivateOfferActionModalProps,
} from './PrivateOfferActionShell'

// The active offer (ZeroDebtClose), and the borrower NFT, a wallet output.
const CLOSE_WEIGHT_UNITS =
  PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.ZeroDebtClose + EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY

/**
 * The borrower closes a loan whose installments paid the whole debt: no amount is left to repay,
 * so the close burns the borrower NFT, reveals the debt's key for the lender's final claim, and
 * takes the collateral back.
 */
export default function CloseZeroDebtModal(props: PrivateOfferActionModalProps) {
  const { item } = props
  const { terms } = item
  const { getLendingKey } = useWallet()
  const { formatCollateralDisplay } = useFormatAmount()

  // `utxo` is the unspent loan output. The outpoints come from the indexer, read again now;
  // `loadLoan` walks the loan back on chain to this offer's acceptance, and the builder checks on
  // chain that the borrower NFT comes from a transaction that claimed this offer's principal. Its
  // refusals are shown in the borrower's words (`borrowerErrorText`).
  const buildClose = async ({ deps, offer, candidate, utxo }: FreshOffer) => {
    const loan = await loadLoan(deps, offer, await getLendingKey(), utxoOutpoint(utxo))
    if (loan.state.remaining !== 0n) {
      throw new Error(
        'This loan still owes an amount, or what it owes is unknown: repay it instead',
      )
    }
    // The close burns the borrower NFT, the only key to an unclaimed principal.
    const borrowerNft = loanBorrowerNftOutpoint(loan.installmentTxids, item.txid, candidate)
    if (borrowerNft === undefined) {
      throw new Error(
        'The indexer lists no receipt of your principal. Receive it first: once you close the ' +
          'loan, it can no longer be received.',
      )
    }
    const feeCoins = selectFeeCoins(
      deps.walletUtxos(),
      deps.assets.policy,
      CLOSE_WEIGHT_UNITS,
      deps.feeRate,
    )
    return buildZeroDebtClose(deps, offer, loan, {
      borrowerNftOutpoint: borrowerNft,
      feeCoins,
      collateralReceiver: walletReceiver(deps),
    })
  }
  const build = (fresh: FreshOffer) =>
    buildClose(fresh).catch((error: unknown) => {
      throw asBorrowerError(error)
    })

  const summary = useMemo(
    () => [
      { label: 'You repay', value: 'Nothing: your installments paid the debt' },
      { label: 'Collateral back to you', value: formatCollateralDisplay(terms.collateralAmount) },
    ],
    [terms, formatCollateralDisplay],
  )
  const label = borrowerActions(null).labels.closeZeroDebt

  return (
    <PrivateOfferActionShell
      {...props}
      kind='private_zero_debt_close'
      requires='active_offer'
      title='Close your loan'
      chip={
        <Chip color='success' variant='soft' size='sm'>
          Paid
        </Chip>
      }
      label={label}
      eyebrow={label}
      summary={summary}
      build={build}
    />
  )
}
