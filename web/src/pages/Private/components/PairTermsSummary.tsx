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
  /**
   * A directory entry's terms as `checkDirectoryEntry` verified them; null when the entry did not
   * verify, and when it has no terms.
   */
  verifiedTerms: LenderTermsInput | null
  /** The entry's `terms_published_at`: unix seconds, null when it has no terms. */
  publishedAt: number | null
}

/**
 * A lender's verified terms for the configured pair, and when the indexer says they were
 * published. Terms for other pairs are not shown, nor terms that did not verify.
 */
export default function PairTermsSummary({ verifiedTerms, publishedAt }: PairTermsSummaryProps) {
  const { collateralAsset: collateral, principalAsset: principal } = NETWORK_CONFIG
  const pair = findPairTerms(verifiedTerms, { collateral, principal })
  if (pair === undefined) {
    return (
      <p className='text-muted text-xs'>
        {verifiedTerms !== null
          ? `No terms for ${principal.symbol} against ${collateral.symbol}.`
          : publishedAt === null
            ? 'No terms published.'
            : 'These terms could not be verified'}
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
