import { Checkbox } from '@heroui/react'
import { useId, useMemo, useState } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import { fetchLatestBlockHeight } from '@/api/esplora/methods'
import MessageField from '@/components/MessageField'
import { MessageEntry } from '@/components/MessageTimeline'
import Notice from '@/components/Notice'
import { OfferStatusChip } from '@/components/OfferStatusChip'
import { NETWORK_CONFIG } from '@/constants/network-config'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { buildPrivateAcceptance } from '@/privateLending/flows/acceptance'
import { openSentMessages } from '@/privateLending/hooks/usePrivateOffers'
import { MESSAGE_NOTE, messageError, messageToSend } from '@/privateLending/messages'
import { canStillAccept, checkStillAcceptable, TERM_PASSED_NOTE } from '@/privateLending/offerView'
import type { TermsVerdict } from '@/privateLending/proposalCheck'
import { recordingSent } from '@/privateLending/sentMessages'
import { selectAssetCoins, selectFeeCoins, walletReceiver } from '@/privateLending/wallet'
import { useLwk } from '@/providers/lwk/useLwk'
import { useWallet } from '@/providers/wallet/useWallet'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'
import { SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/script-auth/witness'

import PrivateOfferActionShell, {
  type FreshOffer,
  type PrivateOfferActionModalProps,
} from './PrivateOfferActionShell'

// The covenant inputs: the pending offer and the lender NFT at its script_auth lock.
const ACCEPT_WEIGHT_UNITS =
  PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.OfferAcceptance + SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY

/** Why a proposal is not known to be within the lender's terms, in plain words. */
function verdictReasons(verdict: Exclude<TermsVerdict, { kind: 'within' }>): string[] {
  if (verdict.kind === 'outside') return verdict.labels
  return verdict.reason === 'no-terms'
    ? ['you have no published terms to check it against']
    : ['your published terms do not verify, so it cannot be checked against them']
}

/**
 * The borrower's message with the proposal, part of its signed terms: plain text, with its sender
 * and the note that the contract does not enforce it.
 */
function ProposalMessage({
  item,
  borrowerName,
}: {
  item: PrivateOfferActionModalProps['item']
  borrowerName: string | undefined
}) {
  const headingId = useId()
  const { message } = item.terms
  if (message === undefined) return null
  return (
    <section aria-labelledby={headingId} className='flex flex-col gap-2'>
      <h3 id={headingId} className='text-foreground text-sm font-medium'>
        Message from the borrower
      </h3>
      <MessageEntry
        message={{
          phase: 'creation',
          from: 'borrower',
          txid: item.txid,
          state: 'verified',
          text: message,
        }}
        sender={{ name: borrowerName, fingerprint: item.terms.borrowerFingerprint }}
      />
      <p className='text-muted text-xs'>{MESSAGE_NOTE}</p>
    </section>
  )
}

/**
 * The proposal against the lender's terms; outside them, acceptance waits for the lender's tick.
 */
function TermsSection({
  verdict,
  acceptOutside,
  onAcceptOutside,
}: {
  verdict: TermsVerdict
  acceptOutside: boolean
  onAcceptOutside: (accept: boolean) => void
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className='flex flex-col gap-2'>
      <h3 id={headingId} className='text-foreground text-sm font-medium'>
        Against your terms
      </h3>
      {verdict.kind === 'within' ? (
        <p className='text-muted text-sm'>The proposal is within your published terms.</p>
      ) : (
        <Notice className='flex flex-col gap-3'>
          <div className='flex flex-col gap-1'>
            <p>
              {verdict.kind === 'outside'
                ? 'This proposal is outside your terms:'
                : 'This proposal is not checked against your terms:'}
            </p>
            <ul className='list-disc pl-5'>
              {verdictReasons(verdict).map(reason => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
          <Checkbox isSelected={acceptOutside} onChange={onAcceptOutside}>
            <Checkbox.Content className='text-foreground'>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              Accept outside my terms
            </Checkbox.Content>
          </Checkbox>
        </Notice>
      )}
    </section>
  )
}

interface AcceptPrivateOfferModalProps extends PrivateOfferActionModalProps {
  /** The proposal against the lender's own verified terms (`checkAgainstTerms`). */
  verdict: TermsVerdict
}

/**
 * The lender accepts a pending offer: it pays the principal, locked to the borrower NFT, and
 * receives the lender NFT at its wallet address. A proposal outside the lender's terms, or one
 * that could not be checked against them, lists why, and is accepted only once the lender ticks
 * "Accept outside my terms". The borrower's message, if any, shows above the terms. The lender
 * may add a private message to the borrower, which the principal output carries; the acceptance
 * is recorded with its text, or none, among the messages this browser sent.
 */
export default function AcceptPrivateOfferModal({
  verdict,
  ...props
}: AcceptPrivateOfferModalProps) {
  const { terms } = props.item
  const [acceptOutside, setAcceptOutside] = useState(false)
  const [messageText, setMessageText] = useState('')
  const { principalAsset } = NETWORK_CONFIG
  const { network } = useLwk()
  const { confirmedBalances, getLendingKey } = useWallet()
  const { formatCollateralDisplay, formatPrincipalAmount } = useFormatAmount()
  const { data: tipHeight } = useBlockHeight()

  const insufficientBalance =
    BigInt(confirmedBalances[principalAsset.id] ?? 0) < terms.principalAmount
  const needsTick = verdict.kind !== 'within' && !acceptOutside
  const messageTooLong = messageError(messageText, 'signed') !== null

  // The acceptance sets no lock time and the covenant does not check the expiry: the tip, read
  // fresh, is checked before the build and again before any broadcast, a retry's included.
  const checkTerm = async () => checkStillAcceptable(terms, await fetchLatestBlockHeight())
  // A saved acceptance whose term passed can only be discarded: `checkTerm` would refuse it.
  const unsentBlockedNote =
    tipHeight > 0 && !canStillAccept(terms, tipHeight) ? TERM_PASSED_NOTE : null

  // The indexer must still list the pending offer unspent (`requires`); the builder spends output
  // 3 of the creation the gate verified.
  const build = async ({ deps, offer }: FreshOffer) => {
    await checkTerm()
    if (offer.opened.principalAsset() !== principalAsset.id) {
      throw new Error(`The offer's principal is not ${principalAsset.symbol}`)
    }
    const coins = deps.walletUtxos()
    const principalCoins = selectAssetCoins(
      coins,
      principalAsset.id,
      offer.opened.principalAmount(),
      principalAsset.symbol,
    )
    const feeCoins = selectFeeCoins(
      coins,
      deps.assets.policy,
      ACCEPT_WEIGHT_UNITS,
      deps.feeRate,
      principalCoins,
    )
    const lendingKey = await getLendingKey()
    const message = messageToSend(messageText)
    const sent = await openSentMessages(network, lendingKey)
    const built = await buildPrivateAcceptance(deps, offer, {
      principalCoins,
      feeCoins,
      lenderNftReceiver: walletReceiver(deps),
      lendingKey,
      message,
    })
    return recordingSent(built, sent, {
      offerTxid: offer.creationTx.txid().toString(),
      phase: 'acceptance',
      ...(message === undefined ? {} : { text: message }),
    })
  }

  const summary = useMemo(
    () => [
      { label: 'Collateral', value: formatCollateralDisplay(terms.collateralAmount) },
      { label: 'Principal you lend', value: formatPrincipalAmount(terms.principalAmount) },
      { label: 'Repayment', value: formatPrincipalAmount(terms.repaymentAmount) },
      { label: 'Interest', value: formatPrincipalAmount(terms.interest) },
      { label: 'Expiry block', value: `#${terms.loanExpirationTime}` },
    ],
    [terms, formatCollateralDisplay, formatPrincipalAmount],
  )

  return (
    <PrivateOfferActionShell
      {...props}
      kind='private_accept_offer'
      requires='pending_offer'
      title='Accept proposal'
      chip={<OfferStatusChip status='pending' />}
      label='Accept and lend'
      eyebrow='Accept proposal'
      summary={summary}
      disabled={insufficientBalance || needsTick || messageTooLong}
      notice={
        <div className='flex flex-col gap-4'>
          <ProposalMessage item={props.item} borrowerName={props.counterpartyName} />
          <TermsSection
            verdict={verdict}
            acceptOutside={acceptOutside}
            onAcceptOutside={setAcceptOutside}
          />
          {insufficientBalance && (
            <Notice>
              Your confirmed {principalAsset.symbol} balance is too low to lend this principal.
            </Notice>
          )}
          <div className='flex flex-col gap-2'>
            <MessageField channel='signed' value={messageText} onChange={setMessageText} />
            <p className='text-muted text-xs'>
              Only the borrower can read it; you can read it again only in this browser. It is not
              part of the terms, and the contract does not enforce it.
            </p>
          </div>
        </div>
      }
      build={build}
      beforeBroadcast={checkTerm}
      unsentBlockedNote={unsentBlockedNote}
    />
  )
}
