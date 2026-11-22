import { Chip } from '@heroui/react'
import { useMemo, useState } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import { fetchLatestBlockHeight } from '@/api/esplora/methods'
import { loanAmounts } from '@/areas/borrow/proposalForm'
import DetailsPanel from '@/components/DetailsPanel'
import MessageField from '@/components/MessageField'
import Notice from '@/components/Notice'
import { UiTextField } from '@/components/ui/UiTextField'
import { NETWORK_CONFIG } from '@/constants/network-config'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { useReadError } from '@/hooks/useReadError'
import type { AsyncUpdatedPset } from '@/lwk/updatedPset'
import { asBorrowerError } from '@/privateLending/borrowerErrors'
import { loanBorrowerNftOutpoint, unspentCarries, utxoOutpoint } from '@/privateLending/candidate'
import { releaseForPayment } from '@/privateLending/collateralFigures'
import {
  buildPrivateInstallment,
  type InstallmentSummary,
  R2_EXTRA_OUTPUT_AMOUNT,
} from '@/privateLending/flows/installment'
import { buildPrivateRepayment, type RepaymentSummary } from '@/privateLending/flows/repayment'
import { outpointOf } from '@/privateLending/flows/shared'
import { useLoan } from '@/privateLending/hooks/useLoan'
import { unitsToDecimal } from '@/privateLending/lenderTerms'
import { loadLoan } from '@/privateLending/loan'
import { messageError, messageToSend } from '@/privateLending/messages'
import { borrowerActions, borrowerTermEnded, offerTxState } from '@/privateLending/offerView'
import {
  checkInstallmentTerm,
  installmentTraceInputs,
  installmentTraces,
  repayBroadcast,
  type RepayPlan,
  repayPlan,
} from '@/privateLending/repayPlan'
import { INSTALLMENT_WEIGHT_UNITS, REPAY_WEIGHT_UNITS } from '@/privateLending/repayWeights'
import { recordingSent, sentMessagesOf } from '@/privateLending/sentMessages'
import { selectAssetCoins, selectFeeCoins, walletReceiver } from '@/privateLending/wallet'
import { useLwk } from '@/providers/lwk/useLwk'
import { loadPrivateTxsForWallet } from '@/providers/pendingTransactions/storage'
import type { PrivateTxRecord } from '@/providers/pendingTransactions/types'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'
import { useWallet } from '@/providers/wallet/useWallet'
import { ErrorHandler } from '@/utils/errorHandler'

import PrivateOfferActionShell, {
  type FreshOffer,
  type PrivateOfferActionModalProps,
} from './PrivateOfferActionShell'

/** The kinds the repay form saves. */
const REPAY_TX_KINDS = ['private_installment', 'private_repay_offer'] as const

/**
 * The borrower repays an accepted loan: an installment of the amount typed, below what the loan
 * still owes, or the full repayment of it, which burns the borrower NFT, pays the rest to the
 * lender and takes the collateral back. Installments are not refunded if the loan is liquidated,
 * so none is paid from the expiry block on (`repayPlan`). The action keeps the name of its button
 * in My loans: "Repay 3,021.40 TEST". Either payment may carry a private message to the lender, and
 * is recorded with its text, or none, among the messages this browser sent.
 */
export default function RepayPrivateOfferModal(props: PrivateOfferActionModalProps) {
  const { item, unsentTx } = props
  const { terms } = item
  const { principalAsset } = NETWORK_CONFIG
  const { network } = useLwk()
  const { confirmedBalances, getLendingKey, scriptPubkey } = useWallet()
  const { privateTxs, discardedTxs } = usePendingTransactions()
  const { data: tipHeight } = useBlockHeight()
  const { formatCollateralDisplay, formatPrincipalAmount } = useFormatAmount()
  const loanQuery = useLoan(item)
  const loan = loanQuery.data
  // kept through the retries every 30 seconds, which would otherwise show "Reading the loan…"
  const loanError = useReadError(loanQuery)
  const owed = loan?.remaining
  const expiry = terms.loanExpirationTime

  // The amount typed, or null for the default: what the loan still owes.
  const [typed, setTyped] = useState<string | null>(null)
  const [messageText, setMessageText] = useState('')
  const messageRefused = messageError(messageText, 'signed') !== null
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
          installmentCount: loan?.installments.length ?? 0,
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
  // The collateral the loan holds now, and what this payment releases of it: the whole for the
  // full repayment, `c_k − ceil((d_k − p)·C/R)` for an installment (it can be 0). The build
  // checks the same figure against the wasm's `releasePreview`.
  const held = loan?.collateral
  const release =
    held === undefined || owed === undefined || pays === undefined
      ? undefined
      : releaseForPayment(
          {
            total: terms.collateralAmount,
            repayment: terms.repaymentAmount,
            owed,
            held,
          },
          pays,
        )
  const insufficientBalance =
    pays !== undefined && BigInt(confirmedBalances[principalAsset.id] ?? 0) < pays
  // From the expiry block on, as the plan refuses an installment.
  const isExpired = borrowerTermEnded(terms, tipHeight)

  // `utxo` is the unspent loan output. The outpoints come from the indexer, read again now;
  // `loadLoan` walks the loan back on chain to this offer's acceptance, and the builder checks on
  // chain that the borrower NFT comes from a transaction that claimed this offer's principal. Its
  // refusals are shown in the borrower's words (`borrowerErrorText`).
  const buildPayment = async ({
    deps,
    offer,
    candidate,
    utxo,
  }: FreshOffer): Promise<AsyncUpdatedPset<InstallmentSummary | RepaymentSummary>> => {
    if (plan === undefined || plan.kind === 'refused') {
      throw new Error(plan?.message ?? 'The amount this loan still owes is not read yet')
    }
    const lendingKey = await getLendingKey()
    const message = messageToSend(messageText)
    const fresh = await loadLoan(deps, offer, lendingKey, utxoOutpoint(utxo))
    const freshOwed = fresh.state.remaining
    if (freshOwed === undefined) {
      throw new Error(
        'A payment on this loan does not open with your key, so what it still owes is unknown',
      )
    }
    // The form's plan, again against the loan read now and a fresh tip: the kind it is saved
    // under must be the one built. An installment's builder checks that tip again.
    const freshTip = plan.kind === 'installment' ? await fetchLatestBlockHeight() : tipHeight
    const freshPlan = repayPlan({
      remaining: freshOwed,
      amountText,
      decimals: principalAsset.decimals,
      symbol: principalAsset.symbol,
      tipHeight: freshTip,
      expiry,
      installmentCount: fresh.state.installmentCount,
    })
    if (freshPlan.kind === 'refused') throw new Error(freshPlan.message)
    if (freshPlan.kind !== plan.kind || freshPlan.amount !== plan.amount) {
      throw new Error('The loan changed since the form was filled: check the amount again')
    }
    // The repayment burns the borrower NFT, the only key to an unclaimed principal: it needs the
    // indexer's evidence of the claim, and never falls back to the NFT where the creation put it.
    // After installments, it is at the last one's output 0.
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
    // The loan's carries as the indexer lists them: the builders take them only when they are the
    // carries the loan opens on chain.
    const carryOutpoints = unspentCarries(candidate)
    const sent = sentMessagesOf(network, lendingKey.fingerprint())
    const sentText = message === undefined ? {} : { text: message }
    const offerTxid = offer.creationTx.txid().toString()
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
      const built = await buildPrivateRepayment(deps, offer, fresh, {
        borrowerNftOutpoint: borrowerNft,
        principalCoins,
        feeCoins,
        carryOutpoints,
        collateralReceiver: walletReceiver(deps),
        lendingKey,
        message,
      })
      return recordingSent(built, sent, { offerTxid, phase: 'repayment', ...sentText })
    }
    // An installment derives its key from the loan output, its first wallet input (input 2) and
    // the NFT's receiver script: it never starts from the first input of an earlier installment
    // of this loan saved here (discarded, or failed), which may have reached the network with the
    // same key, and it pays the same amount (the builder checks both: `earlierBuilds`). The saved
    // records are read again now, as another tab may have saved one since this tab loaded its
    // list, and no installment is built if they cannot be read.
    let stored: PrivateTxRecord[]
    try {
      if (scriptPubkey === null) throw new Error('No wallet is connected')
      stored = await loadPrivateTxsForWallet(scriptPubkey)
    } catch (error) {
      throw new Error('Saved payments could not be read; reload the page', { cause: error })
    }
    const saved = [...stored, ...privateTxs, ...discardedTxs]
    const traced = installmentTraceInputs(deps.lwk, saved, fresh.state.loanOutpoint)
    const earlierBuilds = installmentTraces(deps.lwk, saved, fresh.state.loanOutpoint).map(
      record => record.txHex,
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
    // the fee, and R2's output when the installment releases nothing
    const feeCoins = selectFeeCoins(
      coins,
      deps.assets.policy,
      INSTALLMENT_WEIGHT_UNITS,
      deps.feeRate,
      principalCoins,
      R2_EXTRA_OUTPUT_AMOUNT,
    )
    // The loan's next installment, which the builder signs the message for.
    const installment = fresh.state.installmentCount + 1
    const built = await buildPrivateInstallment(deps, offer, fresh, {
      amount: freshPlan.amount,
      borrowerNftOutpoint: borrowerNft,
      principalCoins,
      feeCoins,
      carryOutpoints,
      earlierBuilds,
      lendingKey,
      tipHeight: freshTip,
      message,
    })
    return recordingSent(built, sent, { offerTxid, phase: 'installment', installment, ...sentText })
  }
  const build = (fresh: FreshOffer) =>
    buildPayment(fresh).catch((error: unknown) => {
      throw asBorrowerError(error)
    })

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
              value: held === undefined ? 'What the loan holds' : formatCollateralDisplay(held),
            },
          ]
    }
    if (pays === undefined || owed === undefined) return []
    if (plan?.kind === 'full') {
      return [
        { label: 'You repay', value: formatPrincipalAmount(pays) },
        {
          label: 'Collateral back to you',
          value: held === undefined ? 'What the loan holds' : formatCollateralDisplay(held),
        },
      ]
    }
    return [
      { label: 'You pay', value: formatPrincipalAmount(pays) },
      { label: 'Still owed after it', value: formatPrincipalAmount(owed - pays) },
      ...(release === undefined || held === undefined
        ? []
        : [
            { label: 'Collateral released', value: formatCollateralDisplay(release) },
            { label: 'Collateral left after it', value: formatCollateralDisplay(held - release) },
          ]),
    ]
  }, [
    unsentRecord,
    isInstallment,
    owed,
    pays,
    held,
    release,
    plan?.kind,
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
        loanError !== undefined ? (
          <Notice role='alert'>
            The loan could not be read: {ErrorHandler.describe(asBorrowerError(loanError))}
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
              ...(held === undefined
                ? []
                : [
                    {
                      label: 'Collateral released so far',
                      value: formatCollateralDisplay(terms.collateralAmount - held),
                    },
                    { label: 'Collateral left', value: formatCollateralDisplay(held) },
                  ]),
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
                : 'Less than you owe pays an installment, which releases part of your collateral; ' +
                  'the rest stays owed.'
            }
            errorMessage={plan?.kind === 'refused' ? plan.message : undefined}
          />
          <p className='text-muted text-sm'>
            Installments are not refunded if the loan is liquidated: the lender keeps them and the
            collateral.
          </p>
          <div className='flex flex-col gap-2'>
            <MessageField channel='signed' value={messageText} onChange={setMessageText} />
            <p className='text-muted text-xs'>
              {plan?.kind === 'installment'
                ? 'The lender reads it, and you can read it again from your wallet on any device.'
                : plan?.kind === 'full'
                  ? 'The lender reads it; you can read it again only in this browser.'
                  : 'The lender reads it.'}{' '}
              It is not part of the loan&apos;s terms, and nothing enforces it.
            </p>
          </div>
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
      disabled={pays === undefined || insufficientBalance || messageRefused}
      notice={form}
      build={build}
      beforeBroadcast={beforeBroadcast}
      unsentBlockedNote={unsentBlockedNote}
    />
  )
}
