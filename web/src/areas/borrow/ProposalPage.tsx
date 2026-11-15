import { type FormEvent, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'

import { useBlockHeight } from '@/api/esplora/hooks'
import KeyFingerprint from '@/components/KeyFingerprint'
import CreatePrivateOfferModal, {
  type PrivateOfferDraft,
} from '@/components/modals/private/CreatePrivateOfferModal'
import Notice from '@/components/Notice'
import { UiButton } from '@/components/ui/UiButton'
import { UiTextField } from '@/components/ui/UiTextField'
import { RoutePath } from '@/constants/routes'
import { useFeeRateSatPerKvb } from '@/hooks/useFeeRate'
import { useKeyedModal } from '@/hooks/useKeyedModal'
import { type PolicyAssetUtxo, usePolicyAssetUtxos } from '@/hooks/usePolicyAssetUtxos'
import { formatAprBps, proposalExpiry, unitsFromDecimal } from '@/privateLending/lenderTerms'
import type { ProposalForm } from '@/privateLending/proposalCheck'
import { pickCreationCoins } from '@/privateLending/wallet'
import type { PrivateLendingWasm } from '@/privateLending/wasm'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'
import { normalizeHex } from '@/utils/hex'

import { type ChooseLenderState, LendersPendingView } from './ChooseLenderPage'
import {
  amountText,
  dateAfterBlocks,
  editProposalForm,
  openProposalForm,
  proposalOfForm,
} from './proposalForm'
import ProposalSummary from './ProposalSummary'
import { type Lender, PAIR, useLenders } from './useLenders'

const { principal: PRINCIPAL, collateral: COLLATERAL } = PAIR

/** Principal base units as grouped coins with at least 2 decimals and the symbol. */
function principalText(units: bigint): string {
  return `${amountText(units, PRINCIPAL.decimals, 2)} ${PRINCIPAL.symbol}`
}

/** `low to high`, or one figure when they are equal. */
function range(low: string, high: string): string {
  return low === high ? low : `${low} to ${high}`
}

/** What each field says of the lender's terms while it has no error. */
function fieldHints(lender: Lender, wasm: PrivateLendingWasm, principalText: string) {
  const { pair } = lender
  let leastCollateral: string | undefined
  try {
    const principal = unitsFromDecimal(principalText, PRINCIPAL.decimals)
    const least = wasm.minCollateral(principal, BigInt(pair.max_principal_per_collateral))
    const coins = `${amountText(least, COLLATERAL.decimals)} ${COLLATERAL.symbol}`
    leastCollateral = `At least ${coins} for this principal.`
  } catch {
    // No principal yet, or no least collateral that can exist: the field's error says which.
  }
  const low = amountText(BigInt(pair.min_principal), PRINCIPAL.decimals)
  const high = amountText(BigInt(pair.max_principal), PRINCIPAL.decimals)
  return {
    principal: `${range(low, high)} ${PRINCIPAL.symbol}.`,
    days: `${range(String(pair.min_term_days), String(pair.max_term_days))} ${
      pair.max_term_days === 1 ? 'day' : 'days'
    }.`,
    collateral: leastCollateral,
    aprPercent: `At least ${formatAprBps(pair.min_apr_bps)}.`,
  }
}

/** Why the wallet's coins cannot pay `collateral` and the fee, or null when they can. */
function creationCoinsProblem(
  coins: PolicyAssetUtxo[],
  collateral: bigint,
  feeRate: number,
): string | null {
  try {
    pickCreationCoins(coins, coin => coin.value, collateral, feeRate)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const FIELDS: {
  field: keyof ProposalForm
  label: string
  unit: string
  inputMode: 'decimal' | 'numeric'
}[] = [
  { field: 'principal', label: 'Principal', unit: PRINCIPAL.symbol, inputMode: 'decimal' },
  { field: 'days', label: 'Term', unit: 'days', inputMode: 'numeric' },
  { field: 'collateral', label: 'Collateral', unit: COLLATERAL.symbol, inputMode: 'decimal' },
  { field: 'aprPercent', label: 'APR', unit: '%', inputMode: 'decimal' },
]

interface ProposalFormViewProps {
  lender: Lender
  wasm: PrivateLendingWasm
}

/**
 * The proposal to one lender: it opens at the lender's minimums and is sent only within its
 * terms. The coins are picked again, after a wallet sync, when the proposal is built.
 */
function ProposalFormView({ lender, wasm }: ProposalFormViewProps) {
  const navigate = useNavigate()
  const { data: tipHeight } = useBlockHeight()
  const { utxos: coins, isLoading: coinsLoading } = usePolicyAssetUtxos(true)
  const feeRate = useFeeRateSatPerKvb(true)
  const { privateTxs } = usePendingTransactions()
  const { modal, isOpen, open, close } = useKeyedModal<PrivateOfferDraft>()
  const [now] = useState(() => Date.now())

  const [state, setState] = useState(() => openProposalForm(wasm, lender.pair, PAIR))
  const { form } = state
  const { proposal, errors } = proposalOfForm(wasm, lender.pair, PAIR, form)
  const hints = fieldHints(lender, wasm, form.principal)

  // Advisory only: the build syncs the wallet and picks the coins again.
  const coinProblem = coinsLoading
    ? null
    : creationCoinsProblem(coins, proposal?.collateral ?? 1n, feeRate)

  // A signed creation that was not broadcast must be sent or discarded first: a new build could
  // spend the same coins.
  const hasUnsentCreation = privateTxs.some(
    record => record.kind === 'private_create_offer' && record.broadcastStatus === 'built',
  )

  const canSend =
    proposal !== null &&
    tipHeight > 0 &&
    !hasUnsentCreation &&
    !coinsLoading &&
    coinProblem === null

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSend || proposal === null) return
    open({
      lender: { pubkey: lender.pubkey, fingerprint: lender.fingerprint, name: lender.name },
      collateralAmount: proposal.collateral,
      principalAmount: proposal.principal,
      repaymentAmount: proposal.repayment,
      termDays: proposal.days,
      loanExpirationTime: proposalExpiry(tipHeight, proposal.days),
    })
  }

  // The term ends at the expiry the proposal would get now: the days and the margin after the tip.
  const days = proposal?.days ?? lender.pair.min_term_days
  const repayBy = dateAfterBlocks(new Date(now), proposalExpiry(tipHeight, days) - tipHeight)

  return (
    <>
      <form className='flex flex-col gap-8' onSubmit={submit}>
        <section aria-labelledby='proposal-loan' className='flex flex-col gap-4'>
          <h2 id='proposal-loan' className='text-foreground text-sm font-semibold'>
            Your loan
          </h2>
          <div className='grid gap-4 sm:grid-cols-2'>
            {FIELDS.map(({ field, label, unit, inputMode }) => (
              <UiTextField
                key={field}
                aria-label={label}
                label={label}
                inputMode={inputMode}
                autoComplete='off'
                value={form[field]}
                onChange={value =>
                  setState(state => editProposalForm(wasm, lender.pair, PAIR, state, field, value))
                }
                endContent={unit}
                description={hints[field]}
                errorMessage={errors?.[field]}
              />
            ))}
          </div>
        </section>

        <section aria-labelledby='proposal-repayment' className='flex flex-col gap-2'>
          <h2 id='proposal-repayment' className='text-foreground text-sm font-semibold'>
            Repayment
          </h2>
          <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm'>
            <dt className='text-muted'>You repay</dt>
            <dd className='text-foreground text-right tabular-nums'>
              {proposal === null ? '—' : principalText(proposal.repayment)}
            </dd>
            <dt className='text-muted'>Interest</dt>
            <dd className='text-foreground text-right tabular-nums'>
              {proposal === null ? '—' : principalText(proposal.repayment - proposal.principal)}
            </dd>
          </dl>
          <p className='text-muted text-xs'>
            The principal with the interest at your APR over the term.
          </p>
        </section>

        <ProposalSummary lenderName={lender.name} proposal={proposal} repayBy={repayBy} />

        {coinProblem && <Notice>{coinProblem}</Notice>}
        {hasUnsentCreation && (
          <Notice>
            A proposal you signed was not sent. Send it again or discard it in{' '}
            <Link to={RoutePath.BorrowLoans} className='underline'>
              My loans
            </Link>{' '}
            before you make another: a new proposal could spend the same coins.
          </Notice>
        )}

        <UiButton
          type='submit'
          variant='primary'
          className='self-stretch sm:self-start'
          isDisabled={!canSend}
        >
          Lock collateral and send
        </UiButton>
      </form>

      {modal !== null && (
        <CreatePrivateOfferModal
          key={modal.key}
          isOpen={isOpen}
          draft={modal.request}
          onClose={close}
          onCreated={() => navigate(RoutePath.BorrowLoans)}
        />
      )}
    </>
  )
}

/**
 * The borrower's proposal to the lender of the route's key. A key that is not a listed lender
 * with verified terms for the pair, or the session's own key, goes back to the lender list with
 * a note.
 */
export default function ProposalPage() {
  const { lenderKey = '' } = useParams()
  const { lenders, ownKey, wasm, pending } = useLenders()
  const key = normalizeHex(lenderKey)
  const lender = lenders.find(listed => listed.pubkey === key)

  if (pending === null && lender === undefined) {
    const state: ChooseLenderState = {
      note:
        key === ownKey
          ? 'That key is your own: you cannot borrow from yourself. Choose a lender below.'
          : `That lender is not listed with verified terms for ${PRINCIPAL.symbol} against ` +
            `${COLLATERAL.symbol}. Choose a lender below.`,
    }
    return <Navigate to={RoutePath.Borrow} replace state={state} />
  }

  return (
    <div className='flex flex-col gap-6'>
      <header className='flex min-w-0 flex-col gap-1'>
        <h1 className='text-foreground text-2xl font-semibold wrap-break-word'>
          {lender ? (
            <>
              Your proposal to <bdi>{lender.name}</bdi>
            </>
          ) : (
            'Your proposal'
          )}
        </h1>
        {lender && (
          <p className='text-muted flex flex-wrap items-baseline gap-x-2 text-xs'>
            Lender key
            <KeyFingerprint fingerprint={lender.fingerprint} />
          </p>
        )}
      </header>

      {pending !== null ? (
        <LendersPendingView pending={pending} />
      ) : (
        lender && wasm && <ProposalFormView key={lender.pubkey} lender={lender} wasm={wasm} />
      )}
    </div>
  )
}
