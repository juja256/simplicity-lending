import { buttonVariants, Skeleton } from '@heroui/react'
import { Link } from 'react-router-dom'

import ArrowRightIcon from '@/components/icons/ArrowRightIcon'
import ShieldIcon from '@/components/icons/ShieldIcon'
import { UiButton } from '@/components/ui/UiButton'
import { env } from '@/constants/env'
import { RoutePath } from '@/constants/routes'
import { usePrivateOffers } from '@/privateLending/hooks/usePrivateOffers'
import { isOpenedOffer } from '@/privateLending/offerView'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'
import { useWallet } from '@/providers/wallet/useWallet'

function WalletSummary() {
  const { data, isPending, isError, refetch } = usePrivateOffers()
  const { privateTxs } = usePendingTransactions()
  const unsent = privateTxs.some(tx => tx.broadcastStatus === 'built')
  const offers = [...(data?.borrowing ?? []), ...(data?.lending ?? [])]
  const verified = offers.filter(isOpenedOffer)
  const stats = [
    {
      label: 'Open offers',
      value: verified.filter(item => item.candidate.status === 'pending').length,
    },
    {
      label: 'Active loans',
      value: verified.filter(item => item.candidate.status === 'active').length,
    },
    { label: 'Total offers', value: verified.length },
  ]

  if (isError) {
    return (
      <div role='status' className='flex flex-wrap items-center gap-3 text-sm'>
        <p className='text-muted'>Your private loans couldn’t be loaded.</p>
        <UiButton size='sm' variant='secondary' onPress={() => void refetch()}>
          Try again
        </UiButton>
      </div>
    )
  }

  return (
    <div className='flex flex-col gap-3'>
      <dl
        aria-label='Your private loan summary'
        aria-busy={isPending}
        className='grid grid-cols-3 gap-3'
      >
        {stats.map(({ label, value }) => (
          <div key={label} className='bg-surface rounded-xl p-3 sm:p-4'>
            <dt className='text-muted text-xs sm:text-sm'>{label}</dt>
            <dd className='mt-1 text-2xl font-semibold tabular-nums'>
              {isPending ? <Skeleton className='h-8 w-10 rounded' /> : value}
            </dd>
          </div>
        ))}
      </dl>
      {isPending ? (
        <p role='status' className='text-muted text-sm'>
          Checking your private offers…
        </p>
      ) : unsent ? (
        <p className='text-warning text-sm'>
          A signed transaction needs your attention. Open private loans to retry or discard it.
        </p>
      ) : offers.some(item => !isOpenedOffer(item)) ? (
        <p className='text-muted text-sm'>Some offers need review and are not included above.</p>
      ) : verified.length === 0 ? (
        <p className='text-muted text-sm'>
          No private offers yet. Create one or share your lending key to receive an offer.
        </p>
      ) : null}
    </div>
  )
}

export default function PrivateLoansCard() {
  const { isReady, privateCapable, reconnecting } = useWallet()

  return (
    <section
      aria-labelledby='private-loans-title'
      className='bg-surface-secondary border-accent/25 flex flex-col gap-5 rounded-2xl border p-4 sm:p-6'
    >
      <div className='flex flex-col justify-between gap-4 sm:flex-row sm:items-start'>
        <div className='flex max-w-xl flex-col gap-2'>
          <h2 id='private-loans-title' className='text-h3 flex items-center gap-2'>
            <ShieldIcon className='text-accent size-5 shrink-0' />
            Private loans
          </h2>
          <p className='text-muted text-sm'>
            Borrow or lend with someone you choose. Your loan terms are visible only to you and your
            counterparty.
          </p>
        </div>
        <Link
          to={RoutePath.Private}
          className={buttonVariants({ variant: 'primary', className: 'shrink-0 self-start' })}
        >
          Open private loans
          <ArrowRightIcon className='size-4' />
        </Link>
      </div>
      {isReady && privateCapable ? (
        <WalletSummary />
      ) : (
        <p className='text-muted text-sm'>
          {reconnecting
            ? 'Reconnecting your wallet…'
            : isReady
              ? `Private loans work with Jade${env.VITE_DEMO_MODE ? ' or a test-seed wallet' : ''}. Switch wallets to see your offers.`
              : 'Connect your wallet to see your private offers and loans.'}
        </p>
      )}
    </section>
  )
}
