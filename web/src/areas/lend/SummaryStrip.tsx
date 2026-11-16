import type { ReactNode } from 'react'

import { useFormatAmount } from '@/hooks/useFormatAmount'

import type { BookSummary } from './bookSummary'

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='border-separator flex min-w-0 flex-col gap-0.5 py-3 pr-6 pl-6 first:pl-0 [&:not(:first-child)]:border-l'>
      <dt className='text-muted text-xs'>{label}</dt>
      <dd className='text-foreground text-lg font-semibold whitespace-nowrap tabular-nums'>
        {children}
      </dd>
    </div>
  )
}

interface SummaryStripProps {
  summary: BookSummary
  /** The chain tip, or 0 while unknown: then nothing is dated. */
  tipHeight: number
}

/** The lender's book in one row of figures, divided by rules. */
export default function SummaryStrip({ summary, tipHeight }: SummaryStripProps) {
  const { formatCollateralDisplay, formatPrincipalAmount } = useFormatAmount()
  const { waiting, active, lent, collateralHeld, dueWithin7Days, overdue } = summary

  return (
    <dl className='border-separator flex flex-wrap border-y'>
      <Figure label='Waiting for you'>
        {waiting} {waiting === 1 ? 'proposal' : 'proposals'}
      </Figure>
      <Figure label='Active loans'>{active}</Figure>
      <Figure label='Lent out'>{formatPrincipalAmount(lent)}</Figure>
      <Figure label='Collateral held'>{formatCollateralDisplay(collateralHeld)}</Figure>
      <Figure label='Due in 7 days / overdue'>
        {tipHeight > 0 ? (
          <>
            {dueWithin7Days} / <span className={overdue > 0 ? 'text-danger' : ''}>{overdue}</span>
          </>
        ) : (
          <span className='text-muted' title='The chain tip is not known yet'>
            –
          </span>
        )}
      </Figure>
    </dl>
  )
}
