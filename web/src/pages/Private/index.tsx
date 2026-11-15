import { Skeleton } from '@heroui/react'

import CopyButton from '@/components/CopyButton'
import ShieldIcon from '@/components/icons/ShieldIcon'
import KeyFingerprint from '@/components/KeyFingerprint'
import { useDirectory } from '@/privateLending/hooks/useDirectory'
import { useLendingKeyIdentity } from '@/privateLending/hooks/usePrivateFlowDeps'
import { ErrorHandler } from '@/utils/errorHandler'

import BorrowSection from './components/BorrowSection'
import DirectorySection from './components/DirectorySection'
import PrivateLoansCard from './components/PrivateLoansCard'

/** The session's lending key: its fingerprint, its directory name, and the key to share. */
function LendingKeyCard() {
  const identity = useLendingKeyIdentity()
  const { own } = useDirectory()
  // The name the key signed: an entry that did not verify shows the fingerprint alone.
  const ownName = own?.check?.status === 'verified' ? own.entry?.display_name : undefined

  return (
    <section className='bg-surface-secondary flex flex-col gap-4 rounded-3xl p-6'>
      <header className='flex flex-col gap-1'>
        <div className='flex items-center gap-2'>
          <ShieldIcon className='size-5' />
          <h2 className='text-foreground text-[11px] font-semibold tracking-wide uppercase'>
            Private Loans
          </h2>
        </div>
        <p className='text-muted text-sm'>
          Private offers are addressed to a lending key derived from your wallet, and only the
          borrower and the lender can read their terms. Compare key fingerprints with your
          counterparty before you rely on them.
        </p>
      </header>
      <div className='bg-surface flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4'>
        <div className='flex min-w-0 flex-col gap-1'>
          <span className='text-muted text-xs'>Your lending key</span>
          {identity.data ? (
            <KeyFingerprint fingerprint={identity.data.fingerprint} name={ownName} size='lg' />
          ) : identity.isError ? (
            <span className='text-danger text-sm'>{ErrorHandler.describe(identity.error)}</span>
          ) : (
            <Skeleton className='h-6 w-48 rounded' />
          )}
        </div>
        {identity.data && (
          <CopyButton value={identity.data.pubkey} aria-label='Copy your lending key' />
        )}
      </div>
    </section>
  )
}

/** The stand-in for the areas' pages until they are built: it expects `WalletGate` around it. */
export default function PrivatePage() {
  return (
    <div className='flex flex-col gap-6'>
      <PrivateLoansCard />
      <div className='flex flex-col gap-8'>
        <LendingKeyCard />
        <DirectorySection />
        <BorrowSection />
      </div>
    </div>
  )
}
