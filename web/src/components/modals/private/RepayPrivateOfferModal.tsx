import { Chip } from '@heroui/react'
import { useMemo, useState } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import { fetchLatestBlockHeight } from '@/api/esplora/methods'
import { loanAmounts } from '@/areas/borrow/proposalForm'
import DetailsPanel from '@/components/DetailsPanel'
import Notice from '@/components/Notice'
import { UiTextField } from '@/components/ui/UiTextField'
import { NETWORK_CONFIG } from '@/constants/network-config'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import type { UpdatedPset } from '@/lwk/updatedPset'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { loanBorrowerNftOutpoint, utxoOutpoint } from '@/privateLending/candidate'
import {
  buildPrivateInstallment,
  type InstallmentSummary,
} from '@/privateLending/flows/installment'
import { buildPrivateRepayment, type RepaymentSummary } from '@/privateLending/flows/repayment'
import { outpointOf } from '@/privateLending/flows/shared'
import { useLoan } from '@/privateLending/hooks/useLoan'
import { unitsToDecimal } from '@/privateLending/lenderTerms'
import { loadLoan } from '@/privateLending/loan'
import { borrowerActions, isPastExpiry, offerTxState } from '@/privateLending/offerView'
import {
  checkInstallmentTerm,
  installmentTraceInputs,
  repayBroadcast,
  type RepayPlan,
  repayPlan,
} from '@/privateLending/repayPlan'
import { selectAssetCoins, selectFeeCoins, walletReceiver } from '@/privateLending/wallet'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'
import { useWallet } from '@/providers/wallet/useWallet'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'
import { ErrorHandler } from '@/utils/errorHandler'

import PrivateOfferActionShell, {
  type FreshOffer,
  type PrivateOfferActionModalProps,
} from './PrivateOfferActionShell'

// The active offer (FullRepayment or Installment), and the borrower NFT, a wallet output.
const REPAY_WEIGHT_UNITS =
  PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.FullRepayment + EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY
const INSTALLMENT_WEIGHT_UNITS =
  PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.Installment + EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY

/** The kinds the repay form saves. */
const REPAY_TX_KINDS = ['private_installment', 'private_repay_offer'] as const

/**
 * The borrower repays an accepted loan: an installment of the amount typed, below what the loan
 * still owes, or the full repayment of it, which burns the borrower NFT, pays the rest to the
 * lender and takes the collateral back. Installments are not refunded if the loan is liquidated,
 * so none is paid from the expiry block on (`repayPlan`). The action keeps the name of its button
 * in My loans: "Repay 3,021.40 TEST".
 */
export default function RepayPrivateOfferModal(props: PrivateOfferActionModalProps) {
  const { item, unsentTx } = props
  const { terms } = item
  const { principalAsset } = NETWORK_CONFIG
  const { confirmedBalances, getLendingKey } = useWallet()
  const { privateTxs, discardedTxs } = usePendingTransactions()
  const { data: tipHeight } = useBlockHeight()
  const { formatCollateralDisplay, formatPrincipalAmount } = useFormatAmount()
  const loanQuery = useLoan(item)
  const loan = loanQuery.data
  const owed = loan?.remaining
  const expiry = terms.loanExpirationTime

  // The amount typed, or null for the default: what the loan still owes.
  const [typed, setTyped] = useState<string | null>(null)
  const amountText =
    typed ?? (owed === undefined ? '' : unitsToDecimal(owed, principalAsset.decimals))
  const plan: RepayPlan | undefined =
    owed === undefined
      ? undefined
      : repayPlan({
          remaining: owed,
          amountText,
          decimals: principalAsset.decimals,
          symbol: principalAsset.symbol,
          tipHeight,
          expiry,
        })
  // A saved transaction is broadcast as it was built: its kind, not the form's plan, decides
  // whether it is an installment, also when it was saved in this modal and its broadcast failed.
  const saved = offerTxState(privateTxs, item.txid, REPAY_TX_KINDS)
  const unsentRecord = unsentTx ?? (saved?.state === 'unsent' ? saved.record : undefined)
  const { installment: isInstallment, blockedNote: unsentBlockedNote } = repayBroadcast(
    unsentRecord,
    plan,
    tipHeight,
    expiry,
  )
  const pays = plan?.kind === 'refused' ? undefined : plan?.amount
  const insufficientBalance =
    pays !== undefined && BigInt(confirmedBalances[principalAsset.id] ?? 0) < pays
  const isExpired = isPastExpiry(terms, tipHeight)

  // `utxo` is the unspent loan output. The outpoints come from the indexer, read again now;
  // `loadLoan` walks the loan back on chain to this offer's acceptance, and the builder checks on
  // chain that the borrower NFT comes from a transaction that claimed this offer's principal.
  const build = async ({
    deps,
    offer,
    candidate,
    utxo,
  }: FreshOffer): Promise<UpdatedPset<InstallmentSummary | RepaymentSummary>> => {
    if (plan === undefined || plan.kind === 'refused') {
      throw new Error(plan?.message ?? 'The amount this loan still owes is not read yet')
    }
    const lendingKey = await getLendingKey()
    const fresh = await loadLoan(deps, offer, lendingKey, utxoOutpoint(utxo))
    const freshOwed = fresh.state.remaining
    if (freshOwed === undefined) {
      throw new Error(
        'A payment on this loan does not open with your key, so what it still owes is unknown',
      )
    }
    // The form's plan, again against the loan read now and a fresh tip: the kind it is saved
    // under must be the one built.
    const freshPlan = repayPlan({
      remaining: freshOwed,
      amountText,
      decimals: principalAsset.decimals,
      symbol: principalAsset.symbol,
      tipHeight: plan.kind === 'installment' ? await fetchLatestBlockHeight() : tipHeight,
      expiry,
    })
    if (freshPlan.kind === 'refused') throw new Error(freshPlan.message)
    if (freshPlan.kind !== plan.kind || freshPlan.amount !== plan.amount) {
      throw new Error('The loan changed since the form was filled: check the amount again')
    }
    // The repayment and the zero-debt close burn the borrower NFT, the only key to an unclaimed
    // principal: it needs the indexer's evidence of the claim, and never falls back to the NFT
    // where the creation put it. After installments, it is at the last one's output 0.
    const borrowerNft = loanBorrowerNftOutpoint(fresh.installmentTxids, item.txid, candidate)
    if (borrowerNft === undefined) {
      throw new Error(
        'The indexer lists no receipt of your principal. Receive it first: once you repay, ' +
          'it can no longer be received.',
      )
    }
    if (offer.opened.principalAsset() !== principalAsset.id) {
      throw new Error(`The loan's principal is not ${principalAsset.symbol}`)
    }
    const coins = deps.walletUtxos()
    if (freshPlan.kind === 'full') {
      const principalCoins = selectAssetCoins(
        coins,
        principalAsset.id,
        freshOwed,
        principalAsset.symbol,
      )
      const feeCoins = selectFeeCoins(
        coins,
        deps.assets.policy,
        REPAY_WEIGHT_UNITS,
        deps.feeRate,
        principalCoins,
      )
      return buildPrivateRepayment(deps, offer, fresh, {
        borrowerNftOutpoint: borrowerNft,
        principalCoins,
        feeCoins,
        collateralReceiver: walletReceiver(deps),
      })
    }
    // An installment derives its key from the loan output, its first wallet input (input 2) and
    // the NFT's receiver script: it never starts from the first input of an earlier installment
    // of this loan saved here (discarded, or failed), which may have reached the network with the
    // same key.
    const traced = installmentTraceInputs(
      deps.lwk,
      [...privateTxs, ...discardedTxs],
      fresh.state.loanOutpoint,
    )
    const usable = coins.filter(coin => !traced.has(outpointOf(coin)))
    let principalCoins
    try {
      principalCoins = selectAssetCoins(
        usable,
        principalAsset.id,
        freshPlan.amount,
        principalAsset.symbol,
      )
    } catch (error) {
      if (usable.length === coins.length) throw error
      throw new Error(
        `Your other ${principalAsset.symbol} coins cannot pay this installment: an earlier ` +
          'installment of this loan that did not go through started from one of them, and a ' +
          'new one must not. Repay in full, or ' +
          `send your ${principalAsset.symbol} to your own address first.`,
        { cause: error },
      )
    }
    const feeCoins = selectFeeCoins(
      coins,
      deps.assets.policy,
      INSTALLMENT_WEIGHT_UNITS,
      deps.feeRate,
      principalCoins,
    )
    return buildPrivateInstallment(deps, offer, fresh, {
      amount: freshPlan.amount,
      borrowerNftOutpoint: borrowerNft,
      principalCoins,
      feeCoins,
      lendingKey,
    })
  }

  // An installment is sent only before the expiry block, checked again with a fresh tip.
  const beforeBroadcast = isInstallment
    ? async () => checkInstallmentTerm(await fetchLatestBlockHeight(), expiry)
    : undefined

  const summary = useMemo(() => {
    if (unsentRecord) {
      // A saved installment holds no amount the form could state.
      return isInstallment
        ? [{ label: 'You pay', value: 'The saved installment' }]
        : [
            {
              label: 'You repay',
              value: owed === undefined ? 'What the loan owes' : formatPrincipalAmount(owed),
            },
            {
              label: 'Collateral back to you',
              value: formatCollateralDisplay(terms.collateralAmount),
            },
          ]
    }
    if (pays === undefined || owed === undefined) return []
    return plan?.kind === 'full'
      ? [
          { label: 'You repay', value: formatPrincipalAmount(pays) },
          {
            label: 'Collateral back to you',
            value: formatCollateralDisplay(terms.collateralAmount),
          },
        ]
      : [
          { label: 'You pay', value: formatPrincipalAmount(pays) },
          { label: 'Still owed after it', value: formatPrincipalAmount(owed - pays) },
        ]
  }, [
    unsentRecord,
    isInstallment,
    owed,
    pays,
    plan?.kind,
    terms,
    formatCollateralDisplay,
    formatPrincipalAmount,
  ])

  const label = borrowerActions(
    pays === undefined ? null : loanAmounts(terms.principalAmount, pays, principalAsset),
  ).labels.repay
  const shownLabel = plan?.kind === 'installment' ? label.replace(/^Repay/, 'Pay') : label

  const form = (
    <div className='flex flex-col gap-4'>
      {loan === undefined ? (
        loanQuery.isError ? (
          <Notice role='alert'>
            The loan could not be read: {ErrorHandler.describe(loanQuery.error)}
          </Notice>
        ) : (
          <p role='status' className='text-muted text-sm'>
            Reading the loan…
          </p>
        )
      ) : owed === undefined ? (
        <Notice>
          A payment on this loan does not open with your key, so what it still owes is unknown and
          the app cannot repay it.
        </Notice>
      ) : (
        <>
          <DetailsPanel
            rows={[
              { label: 'Paid so far', value: formatPrincipalAmount(loan.paid) },
              { label: 'Still owed', value: formatPrincipalAmount(owed) },
            ]}
          />
          <UiTextField
            label='Amount'
            inputMode='decimal'
            autoComplete='off'
            value={amountText}
            onChange={setTyped}
            endContent={principalAsset.symbol}
            description={
              plan?.kind === 'full'
                ? 'The whole debt: your collateral comes back to you.'
                : 'Less than you owe pays an installment; the rest stays owed.'
            }
            errorMessage={plan?.kind === 'refused' ? plan.message : undefined}
          />
          <p className='text-muted text-sm'>
            Installments are not refunded if the loan is liquidated: the lender keeps them and the
            collateral.
          </p>
        </>
      )}
      {insufficientBalance ? (
        <Notice>
          Your confirmed {principalAsset.symbol} balance is too low: you pay{' '}
          {formatPrincipalAmount(pays ?? 0n)}.
        </Notice>
      ) : (
        isExpired && (
          <Notice>
            The term ended at block #{expiry}. The lender may take your collateral at any time;
            until then you can still repay in full.
          </Notice>
        )
      )}
    </div>
  )

  return (
    <PrivateOfferActionShell
      {...props}
      kind={plan?.kind === 'installment' ? 'private_installment' : 'private_repay_offer'}
      requires='active_offer'
      title='Repay your loan'
      chip={
        <Chip color='success' variant='soft' size='sm'>
          Active
        </Chip>
      }
      label={shownLabel}
      eyebrow={shownLabel}
      summary={summary}
      disabled={pays === undefined || insufficientBalance}
      notice={form}
      build={build}
      beforeBroadcast={beforeBroadcast}
      unsentBlockedNote={unsentBlockedNote}
    />
  )
}
