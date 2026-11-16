import { NETWORK_CONFIG } from '@/constants/network-config'
import {
  findPairTerms,
  formatAprBps,
  type LenderTermsInput,
  maxPrincipalPerCollateralToDisplay,
} from '@/privateLending/lenderTerms'
import { formatAmount } from '@/utils/format'

interface PairTermsSummaryProps {
  /**
   * A directory entry's terms as `checkDirectoryEntry` verified them; null when the entry did not
   * verify, and when there is no entry.
   */
  verifiedTerms: LenderTermsInput | null
  /** There is an entry, but it did not verify against its key (unsigned or invalid). */
  unverified?: boolean
}

/**
 * A lender's verified terms for the configured pair. Terms for other pairs are not shown, nor
 * terms that did not verify.
 */
export default function PairTermsSummary({ verifiedTerms, unverified }: PairTermsSummaryProps) {
  const { collateralAsset: collateral, principalAsset: principal } = NETWORK_CONFIG
  const pair = findPairTerms(verifiedTerms, { collateral, principal })
  if (pair === undefined) {
    return (
      <p className='text-muted text-xs'>
        {verifiedTerms !== null
          ? `No terms for ${principal.symbol} against ${collateral.symbol}.`
          : unverified
            ? 'These terms could not be verified.'
            : 'No terms published.'}
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
