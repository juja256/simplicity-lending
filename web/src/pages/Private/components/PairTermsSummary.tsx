import { NETWORK_CONFIG } from '@/constants/network-config'
import {
  findPairTerms,
  formatAprBps,
  formatPublishedAt,
  type LenderTermsInput,
  maxPrincipalPerCollateralToDisplay,
} from '@/privateLending/lenderTerms'
import { formatAmount } from '@/utils/format'

interface PairTermsSummaryProps {
  /** A directory entry's terms; null when it has none, or none the app could read. */
  terms: LenderTermsInput | null
  /** Unix seconds; null when the entry has no terms. */
  publishedAt: number | null
}

/**
 * A lender's terms for the configured pair, as the directory serves them, and when they were
 * published. Terms for other pairs are not shown.
 */
export default function PairTermsSummary({ terms, publishedAt }: PairTermsSummaryProps) {
  const { collateralAsset: collateral, principalAsset: principal } = NETWORK_CONFIG
  const pair = findPairTerms(terms, { collateral, principal })
  if (pair === undefined) {
    return (
      <p className='text-muted text-xs'>
        {terms === null
          ? 'No terms published.'
          : `No terms for ${principal.symbol} against ${collateral.symbol}.`}
      </p>
    )
  }

  const rows: [string, string][] = [
    ['Least APR', formatAprBps(pair.min_apr_bps)],
    [
      'Most principal',
      `${maxPrincipalPerCollateralToDisplay(
        BigInt(pair.max_principal_per_collateral),
        principal.decimals,
        collateral.decimals,
      )} ${principal.symbol} per ${collateral.symbol}`,
    ],
    ['Term', `${pair.min_term_days} to ${pair.max_term_days} days`],
    [
      'Principal',
      `${formatAmount(BigInt(pair.min_principal), principal.decimals)} to ${formatAmount(
        BigInt(pair.max_principal),
        principal.decimals,
      )} ${principal.symbol}`,
    ],
    ['Published', publishedAt === null ? '—' : formatPublishedAt(publishedAt)],
  ]
  return (
    <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs'>
      {rows.map(([label, value]) => (
        <div key={label} className='contents'>
          <dt className='text-muted'>{label}</dt>
          <dd className='text-foreground min-w-0 break-words tabular-nums'>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
