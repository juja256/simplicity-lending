import { buttonVariants, Skeleton } from '@heroui/react'
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

import KeyFingerprint from '@/components/KeyFingerprint'
import Notice from '@/components/Notice'
import PairTermsSummary from '@/components/PairTermsSummary'
import { UiButton } from '@/components/ui/UiButton'
import { borrowLenderPath } from '@/constants/routes'
import { ErrorHandler } from '@/utils/errorHandler'

import { timeAgo } from './proposalForm'
import { type Lender, type LendersPending, PAIR, useLenders } from './useLenders'

const PAIR_NAME = `${PAIR.principal.symbol} against ${PAIR.collateral.symbol}`

/** What the proposal page says when it sends the borrower back here. */
export interface ChooseLenderState {
  note?: string
}

/** Why the lenders are not shown yet: a placeholder while they load, or what failed. */
export function LendersPendingView({ pending }: { pending: LendersPending }) {
  switch (pending.kind) {
    case 'loading':
      return <Skeleton className='h-40 w-full rounded-2xl' />
    case 'identity-error':
      return (
        <Notice tone='danger' role='alert'>
          Your wallet could not derive its key for private loans:{' '}
          {ErrorHandler.describe(pending.error)}
        </Notice>
      )
    case 'wasm-error':
      return (
        <Notice tone='danger' role='alert'>
          The app could not load its loan rules: {ErrorHandler.describe(pending.error)}
        </Notice>
      )
    case 'directory-error':
      return (
        <Notice tone='danger' role='alert' className='flex flex-wrap items-center gap-2'>
          <span className='min-w-0 flex-1'>
            The lenders could not be loaded: {ErrorHandler.describe(pending.error)}
          </span>
          <UiButton size='sm' variant='ghost' onPress={pending.retry}>
            Try again
          </UiButton>
        </Notice>
      )
  }
}

/** The lenders left out because their entries did not verify; `more` when some are shown. */
function hiddenNote(count: number, more: boolean): string {
  const lenders = `${count} ${more ? 'more ' : ''}${count === 1 ? 'lender is' : 'lenders are'}`
  return `${lenders} not shown: ${count === 1 ? 'its' : 'their'} terms could not be verified.`
}

function LenderRow({ lender, now }: { lender: Lender; now: number }) {
  const { pubkey, fingerprint, name, pair, publishedAt } = lender
  return (
    <li className='border-separator flex flex-col gap-3 border-b py-5 first:pt-0 last:border-b-0'>
      <div className='flex min-w-0 flex-col gap-1'>
        <h2 className='text-foreground text-base font-semibold wrap-break-word'>
          <bdi>{name}</bdi>
        </h2>
        <p className='text-muted flex flex-wrap items-baseline gap-x-2 text-xs'>
          Lender key
          <KeyFingerprint fingerprint={fingerprint} />
        </p>
      </div>
      <PairTermsSummary verifiedTerms={{ pairs: [pair] }} />
      <p className='text-muted text-xs'>
        Terms published {publishedAt === null ? 'at an unknown time' : timeAgo(publishedAt, now)}
      </p>
      <Link
        to={borrowLenderPath(pubkey)}
        className={`${buttonVariants({ variant: 'primary' })} max-w-full self-start`}
      >
        <span className='min-w-0 truncate'>
          Borrow from <bdi>{name}</bdi>
        </span>
      </Link>
    </li>
  )
}

/**
 * The borrower's first step: the lenders whose terms verified, with those terms, to choose one to
 * propose a loan to. Entries that did not verify are only counted.
 */
export default function ChooseLenderPage() {
  const { lenders, hiddenCount, pending } = useLenders()
  const note = (useLocation().state as ChooseLenderState | null)?.note
  const [now] = useState(() => Date.now())

  return (
    <div className='flex flex-col gap-6'>
      <header className='flex flex-col gap-1'>
        <h1 className='text-foreground text-2xl font-semibold'>Borrow {PAIR_NAME}</h1>
        <p className='text-muted text-sm'>
          Choose a lender whose terms suit you. You propose a loan within them, and the lender
          accepts it or not.
        </p>
      </header>

      {note && <Notice role='alert'>{note}</Notice>}

      {pending !== null ? (
        <LendersPendingView pending={pending} />
      ) : lenders.length === 0 ? (
        <p className='bg-background text-muted rounded-2xl px-4 py-6 text-sm'>
          {hiddenCount > 0
            ? `No lender has published terms for ${PAIR_NAME} that could be verified.`
            : `No lender has published terms for ${PAIR_NAME} yet.`}
        </p>
      ) : (
        <ul className='flex flex-col'>
          {lenders.map(lender => (
            <LenderRow key={lender.pubkey} lender={lender} now={now} />
          ))}
        </ul>
      )}

      {pending === null && hiddenCount > 0 && (
        <p className='text-muted text-sm'>{hiddenNote(hiddenCount, lenders.length > 0)}</p>
      )}
    </div>
  )
}
