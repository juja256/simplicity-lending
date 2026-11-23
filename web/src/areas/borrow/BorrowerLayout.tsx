import { Link, Outlet, useMatch } from 'react-router-dom'

import ArrowRightIcon from '@/components/icons/ArrowRightIcon'
import { JadeUnlockModal } from '@/components/JadeUnlockModal'
import WalletBalances from '@/components/WalletBalances'
import { WalletButton } from '@/components/WalletButton'
import { RoutePath } from '@/constants/routes'

import { NetworkNote } from '../NetworkNote'

const FOCUS_RING =
  'focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-2'

/** The borrower's steps. "Propose" needs a lender, so it is reached from the lender list only. */
const STEPS = [
  { label: 'Choose a lender', to: RoutePath.Borrow },
  { label: 'Propose', to: null },
  { label: 'My loans', to: RoutePath.BorrowLoans },
] as const

/** The step the route is on: `/borrow/loans` before `/borrow/:lenderKey`, which also matches it. */
function useCurrentStep(): number {
  const loans = useMatch(RoutePath.BorrowLoans)
  const proposal = useMatch(RoutePath.BorrowLender)
  if (loans) return 2
  if (proposal) return 1
  return 0
}

function Steps() {
  const current = useCurrentStep()

  return (
    <nav aria-label='Borrowing steps'>
      <ol className='flex flex-wrap items-center gap-x-4 gap-y-2 text-sm'>
        {STEPS.map(({ label, to }, index) => {
          const isCurrent = index === current
          const number = (
            <span
              aria-hidden
              className={`flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${
                isCurrent ? 'bg-accent text-accent-foreground' : 'bg-default text-muted'
              }`}
            >
              {index + 1}
            </span>
          )
          return (
            <li key={label}>
              {isCurrent ? (
                <span
                  aria-current='step'
                  className='text-foreground flex items-center gap-2 font-medium'
                >
                  {number}
                  {label}
                </span>
              ) : to ? (
                <Link
                  to={to}
                  className={`text-muted hover:text-foreground flex items-center gap-2 rounded-sm transition-colors motion-reduce:transition-none ${FOCUS_RING}`}
                >
                  {number}
                  {label}
                </Link>
              ) : (
                <span className='text-muted flex items-center gap-2'>
                  {number}
                  {label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** The borrower app: one centered column, 560 px at most, with the steps in its header. */
export default function BorrowerLayout() {
  return (
    <div className='bg-surface text-foreground min-h-screen'>
      <div className='mx-auto flex min-h-screen w-full max-w-140 flex-col gap-6 px-4 py-6'>
        <header className='flex flex-col gap-4'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <Link to={RoutePath.Landing} className={`flex flex-col rounded-sm ${FOCUS_RING}`}>
              <span className='text-base font-semibold'>Simplicity Lending</span>
              <span className='text-muted text-sm'>Borrow</span>
            </Link>
            <WalletButton />
          </div>
          <WalletBalances layout='row' />
          <div className='border-separator flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b pb-4'>
            <Steps />
            <Link
              to={RoutePath.Lend}
              className={`text-accent inline-flex items-center gap-1 rounded-sm text-sm font-medium hover:underline ${FOCUS_RING}`}
            >
              Lender console
              <ArrowRightIcon className='size-4' />
            </Link>
          </div>
        </header>

        <main className='min-w-0 flex-1'>
          <Outlet />
        </main>

        <footer>
          <NetworkNote />
        </footer>
      </div>
      <JadeUnlockModal />
    </div>
  )
}
