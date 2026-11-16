import { buttonVariants } from '@heroui/react'
import { Link } from 'react-router-dom'

import { RoutePath } from '@/constants/routes'

import { HeroDemoVideo } from './HeroDemoVideo'
import { LandingContainer } from './LandingContainer'

const ENTRANCES = [
  {
    title: 'For lenders',
    description: 'Publish your terms, review proposals, run your book.',
    action: 'Open lender console',
    to: RoutePath.Lend,
  },
  {
    title: 'For borrowers',
    description: 'Pick a lender and borrow against your collateral.',
    action: 'Borrow',
    to: RoutePath.Borrow,
  },
]

/**
 * The site's two areas, side by side: the lender console and the borrower app. `cardClassName`
 * sets the cards' background against the section's.
 */
export function AreaEntrances({
  cardClassName = 'bg-surface-secondary',
}: {
  cardClassName?: string
}) {
  return (
    <ul className='grid w-full grid-cols-1 gap-3 sm:grid-cols-2'>
      {ENTRANCES.map(({ title, description, action, to }) => (
        <li
          key={title}
          className={`${cardClassName} flex flex-col items-start gap-4 rounded-3xl p-6 text-left`}
        >
          <div className='flex flex-col gap-1.5'>
            <h2 className='text-foreground text-lg font-semibold'>{title}</h2>
            <p className='text-muted text-sm'>{description}</p>
          </div>
          <Link to={to} className={`${buttonVariants({ variant: 'primary' })} mt-auto`}>
            {action}
          </Link>
        </li>
      ))}
    </ul>
  )
}

export function Hero() {
  return (
    <LandingContainer
      className='flex flex-col items-center gap-8 pt-8 pb-12 sm:gap-10 sm:py-12 lg:flex-row lg:py-20'
      as='section'
    >
      <div className='order-1 flex w-full min-w-0 max-w-135 flex-col gap-6'>
        <div className='text-foreground flex flex-col gap-6'>
          <p className='text-[28px] leading-9 font-semibold sm:text-[36px] sm:leading-10'>
            The First Self-Custodial Bitcoin Lending Platform
          </p>
          <p className='text-base'>
            Self-custodial bitcoin loans built on mathematically provable smart contracts. Borrow
            against your bitcoin without selling it or triggering a taxable event. Your collateral
            stays in the contract, not in someone else&apos;s hands.
          </p>
        </div>
        <AreaEntrances />
      </div>

      <div className='order-2 w-full min-w-0 max-w-135'>
        <HeroDemoVideo />
      </div>
    </LandingContainer>
  )
}
