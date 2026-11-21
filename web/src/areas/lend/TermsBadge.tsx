import { Skeleton } from '@heroui/react'

import type { TermsVerdict } from '@/privateLending/proposalCheck'

const TONE_CLASS = {
  success: { box: 'bg-success-soft', dot: 'bg-success' },
  warning: { box: 'bg-warning-soft', dot: 'bg-warning' },
  default: { box: 'bg-default', dot: 'bg-muted' },
} as const

function Pill({ tone, children }: { tone: keyof typeof TONE_CLASS; children: string }) {
  const { box, dot } = TONE_CLASS[tone]
  return (
    <span
      className={`${box} text-foreground inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap`}
    >
      <span className={`${dot} size-1.5 shrink-0 rounded-full`} aria-hidden='true' />
      {children}
    </span>
  )
}

/** A `breachLabel` as a badge starts it: `"term shorter than 30 days"` → `"Term shorter…"`. */
function sentence(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/** Why a proposal waits for its creation's block, by what esplora last answered. */
const PENDING_LABEL: Record<NonNullable<TermsBadgeProps['pending']>, string> = {
  unconfirmed: 'Not confirmed yet',
  failed: 'Could not read the chain',
}

interface TermsBadgeProps {
  /**
   * The proposal against the lender's terms; undefined until the terms are loaded and esplora
   * gives the block the proposal's creation confirmed in.
   */
  verdict: TermsVerdict | undefined
  /** The check cannot run: the lender's terms, or the app's loan rules, could not be loaded. */
  failed?: boolean
  /**
   * Why esplora gave no block for the creation yet: it reports the creation unconfirmed, or it
   * could not be read. Undefined while its first answer loads, or once it gave the block.
   */
  pending?: 'unconfirmed' | 'failed'
}

/**
 * A proposal against the lender's own terms: within them, or each term it breaks named in plain
 * words with the lender's figure, or why it could not be checked yet.
 */
export default function TermsBadge({ verdict, failed, pending }: TermsBadgeProps) {
  if (verdict === undefined) {
    if (failed) return <Pill tone='default'>Not checked</Pill>
    if (pending !== undefined) return <Pill tone='default'>{PENDING_LABEL[pending]}</Pill>
    return <Skeleton className='h-5 w-28 rounded-full' />
  }
  switch (verdict.kind) {
    case 'within':
      return <Pill tone='success'>Within your terms</Pill>
    case 'unknown':
      return (
        <Pill tone='warning'>
          {verdict.reason === 'no-terms' ? 'No terms published' : 'Your terms do not verify'}
        </Pill>
      )
    case 'outside':
      return (
        <ul className='flex flex-col items-start gap-1' aria-label='Outside your terms'>
          {verdict.labels.map(label => (
            <li key={label}>
              <Pill tone='warning'>{sentence(label)}</Pill>
            </li>
          ))}
        </ul>
      )
  }
}
