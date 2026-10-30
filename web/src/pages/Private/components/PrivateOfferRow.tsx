import { Chip } from '@heroui/react'
import type { ReactNode } from 'react'

import { getTxExplorerUrl } from '@/api/esplora/utils'
import KeyFingerprint from '@/components/KeyFingerprint'
import { OfferStatusChip } from '@/components/OfferStatusChip'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import type { PrivateOfferItem } from '@/privateLending/hooks/usePrivateOffers'
import {
  counterpartyOf,
  displayStatus,
  expiryLabel,
  usesConfiguredAssets,
} from '@/privateLending/offerView'
import { truncateAddress } from '@/utils/format'

interface PrivateOfferRowProps {
  item: PrivateOfferItem
  /** The counterparty's directory name, if it is listed. */
  counterpartyName?: string
  /** The chain tip, or 0 while unknown. */
  tipHeight: number
  /** A transaction of this browser for the offer waits for its confirmation. */
  isProcessing?: boolean
  /** Why the offer has no action, or what it waits for. */
  note?: ReactNode
  actions?: ReactNode
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex min-w-0 flex-col gap-0.5'>
      <dt className='text-muted text-xs'>{label}</dt>
      <dd className='text-foreground text-sm font-medium tabular-nums'>{children}</dd>
    </div>
  )
}

/**
 * One private offer: its counterparty (the borrower in the lender's inbox, the lender in one's own
 * offers), its terms (when open), its status and its actions.
 */
export default function PrivateOfferRow({
  item,
  counterpartyName,
  tipHeight,
  isProcessing,
  note,
  actions,
}: PrivateOfferRowProps) {
  const { formatCollateralDisplay, formatPrincipalAmount } = useFormatAmount()
  const { terms, candidate } = item
  const status = candidate ? displayStatus(candidate) : null
  const counterparty = counterpartyOf(item)

  return (
    <li className='bg-surface flex flex-col gap-4 rounded-2xl p-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='flex min-w-0 flex-col gap-1'>
          <span className='text-muted text-xs'>
            {item.role === 'lender' ? 'Borrower' : 'Lender'}
          </span>
          {counterparty !== null ? (
            <KeyFingerprint fingerprint={counterparty.fingerprint} name={counterpartyName} />
          ) : (
            <span className='text-muted text-sm'>Unknown</span>
          )}
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          {item.result === 'invalid' ? (
            <Chip color='danger' variant='soft' size='sm'>
              Invalid: {item.code ?? 'unknown'}
            </Chip>
          ) : status !== null ? (
            <OfferStatusChip status={status} isProcessing={isProcessing} />
          ) : (
            <Chip color='default' variant='soft' size='sm'>
              Not indexed
            </Chip>
          )}
          {actions}
        </div>
      </div>

      {terms !== null && usesConfiguredAssets(terms) && (
        <dl className='grid grid-cols-2 gap-3 sm:grid-cols-5'>
          <Stat label='Collateral'>{formatCollateralDisplay(terms.collateralAmount)}</Stat>
          <Stat label='Principal'>{formatPrincipalAmount(terms.principalAmount)}</Stat>
          <Stat label='Repayment'>{formatPrincipalAmount(terms.repaymentAmount)}</Stat>
          <Stat label='Interest'>{formatPrincipalAmount(terms.interest)}</Stat>
          <Stat label='Expiry'>{expiryLabel(terms.loanExpirationTime, status, tipHeight)}</Stat>
        </dl>
      )}

      <div className='text-muted flex flex-wrap items-center justify-between gap-2 text-xs'>
        <span>
          Offer{' '}
          <a
            className='text-accent font-mono hover:underline'
            href={getTxExplorerUrl(item.txid)}
            target='_blank'
            rel='noopener noreferrer'
          >
            {truncateAddress(item.txid)}
          </a>
        </span>
        {note && <span>{note}</span>}
      </div>
    </li>
  )
}
