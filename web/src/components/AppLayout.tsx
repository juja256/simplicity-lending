import { buttonVariants, Chip } from '@heroui/react'
import { Link, NavLink, Outlet } from 'react-router-dom'

import { BellNotificationButton } from '@/components/BellNotificationButton'
import ArrowSquareOutIcon from '@/components/icons/ArrowSquareOutIcon'
import { JadeUnlockModal } from '@/components/JadeUnlockModal'
import OfferActionModal from '@/components/modals/OfferActionModal'
import { WalletButton } from '@/components/WalletButton'
import { env } from '@/constants/env'
import { ExternalLink } from '@/constants/links'
import { RoutePath } from '@/constants/routes'
import { useOfferModal } from '@/hooks/useOfferModal'

const NAV = [
  { to: RoutePath.Dashboard, label: 'Dashboard' },
  { to: RoutePath.Borrow, label: 'Borrow' },
  { to: RoutePath.Supply, label: 'Supply' },
  { to: RoutePath.Private, label: 'Private loans' },
]

const NETWORK_LABEL = { liquid: 'Liquid', liquidtestnet: 'Liquid testnet', regtest: 'Regtest' }

export default function AppLayout() {
  const { close, isOpen, lastOffer } = useOfferModal()
  return (
    <main className='bg-surface text-foreground min-h-screen'>
      <div className='mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 pt-6 pb-12 sm:px-8 lg:gap-10 lg:px-20 lg:pt-10 lg:pb-20'>
        <header className='flex flex-wrap items-center justify-between gap-4'>
          <Link to={RoutePath.Landing} className='flex flex-col gap-2'>
            <div className='flex items-center gap-2'>
              <h1 className='text-3xl leading-none font-black tracking-tight uppercase sm:text-4xl lg:text-[43px] lg:leading-10'>
                Lending
              </h1>
              <Chip color='accent' variant='primary' size='sm'>
                {env.VITE_DEMO_MODE ? 'Testnet demo' : 'Beta'}
              </Chip>
            </div>
            <span className='text-foreground text-xs font-medium tracking-[0.16em] uppercase'>
              powered by Simplicity
            </span>
          </Link>

          <div className='flex flex-wrap items-center gap-3'>
            <a
              className={buttonVariants({ variant: 'ghost' })}
              href={ExternalLink.AboutSimplicity}
              target='_blank'
              rel='noopener noreferrer'
            >
              About Simplicity
              <ArrowSquareOutIcon className='size-4' />
            </a>
            <BellNotificationButton />
            <WalletButton />
          </div>
        </header>

        <nav
          aria-label='Main navigation'
          className='border-separator flex flex-wrap gap-1 border-b pb-3'
        >
          {NAV.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === RoutePath.Dashboard}
              className={({ isActive }) =>
                `rounded-lg px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted hover:bg-surface-secondary hover:text-foreground'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>

        <OfferActionModal offer={lastOffer} isOpen={isOpen} onClose={close} onSuccess={close} />
        <Outlet />
        <JadeUnlockModal />

        <footer className='text-muted flex flex-wrap items-center justify-between gap-3 text-xs'>
          <p>
            {NETWORK_LABEL[env.VITE_NETWORK]}
            {env.VITE_NETWORK === 'liquidtestnet' ? ' · Test assets only' : ''}
          </p>
          {env.VITE_NETWORK === 'liquidtestnet' && (
            <a
              className='text-accent inline-flex items-center gap-1 hover:underline'
              href={ExternalLink.Faucet}
              target='_blank'
              rel='noopener noreferrer'
            >
              Get test assets
              <ArrowSquareOutIcon className='size-3' />
            </a>
          )}
        </footer>
      </div>
    </main>
  )
}
