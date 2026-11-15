import { Skeleton } from '@heroui/react'
import { Link, NavLink, Outlet } from 'react-router-dom'

import ArrowRightIcon from '@/components/icons/ArrowRightIcon'
import { JadeUnlockModal } from '@/components/JadeUnlockModal'
import KeyFingerprint from '@/components/KeyFingerprint'
import { WalletButton } from '@/components/WalletButton'
import { RoutePath } from '@/constants/routes'
import { useDirectory } from '@/privateLending/hooks/useDirectory'
import { useWallet } from '@/providers/wallet/useWallet'

import { NetworkNote } from '../NetworkNote'

const SECTIONS = [
  { to: RoutePath.LendProposals, label: 'Proposals' },
  { to: RoutePath.LendLoans, label: 'Loan book' },
  { to: RoutePath.LendTerms, label: 'Terms' },
  { to: RoutePath.LendProfile, label: 'Profile' },
]

const FOCUS_RING =
  'focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-2'

/** The connected lender: its directory name and key fingerprint, and the wallet button. */
function LenderIdentity() {
  const { isReady, privateCapable } = useWallet()
  const { identity, own } = useDirectory()
  // The name the key signed: an entry that did not verify shows the fingerprint alone.
  const ownName = own?.check?.status === 'verified' ? own.entry?.display_name : undefined

  return (
    <div className='flex min-w-0 flex-wrap items-center gap-3 lg:flex-col lg:items-stretch'>
      {identity ? (
        <div className='flex min-w-0 flex-col gap-0.5'>
          <span className='text-muted text-xs'>Your lending key</span>
          <KeyFingerprint fingerprint={identity.fingerprint} name={ownName} />
        </div>
      ) : isReady && privateCapable ? (
        <Skeleton className='h-9 w-40 rounded' />
      ) : null}
      <WalletButton showSigner />
    </div>
  )
}

/**
 * The lender console: a sidebar with the console's sections on `--background`, the work area on
 * `--surface`. Under 1024 px the sidebar becomes a bar above the work area.
 */
export default function LenderLayout() {
  return (
    <div className='bg-surface text-foreground min-h-screen lg:grid lg:grid-cols-[224px_minmax(0,1fr)]'>
      <aside className='bg-background border-separator flex flex-col gap-4 border-b p-4 lg:sticky lg:top-0 lg:h-screen lg:gap-8 lg:overflow-y-auto lg:border-r lg:border-b-0 lg:py-6'>
        <div className='flex flex-wrap items-center justify-between gap-4 lg:flex-col lg:items-stretch lg:gap-6'>
          <Link to={RoutePath.Landing} className={`flex flex-col rounded-sm ${FOCUS_RING}`}>
            <span className='text-base font-semibold'>Simplicity Lending</span>
            <span className='text-muted text-sm'>Lender console</span>
          </Link>
          <LenderIdentity />
        </div>

        <nav aria-label='Lender console'>
          <ul className='flex flex-wrap gap-1 lg:flex-col'>
            {SECTIONS.map(({ to, label }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  className={({ isActive }) =>
                    `block rounded-lg px-3 py-2 text-sm transition-colors motion-reduce:transition-none ${FOCUS_RING} ${
                      isActive
                        ? 'bg-surface text-foreground font-medium shadow-sm'
                        : 'text-muted hover:bg-default hover:text-foreground'
                    }`
                  }
                >
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className='flex flex-wrap items-center justify-between gap-3 lg:mt-auto lg:flex-col lg:items-start'>
          <Link
            to={RoutePath.Borrow}
            className={`text-accent inline-flex items-center gap-1 rounded-sm text-sm font-medium hover:underline ${FOCUS_RING}`}
          >
            Borrower side
            <ArrowRightIcon className='size-4' />
          </Link>
          <NetworkNote />
        </div>
      </aside>

      <main className='min-w-0 px-4 py-6 sm:px-8 lg:px-10 lg:py-8'>
        <Outlet />
      </main>
      <JadeUnlockModal />
    </div>
  )
}
