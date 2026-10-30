import { Skeleton, Spinner } from '@heroui/react'

import BackLink from '@/components/BackLink'
import CopyButton from '@/components/CopyButton'
import ShieldIcon from '@/components/icons/ShieldIcon'
import { WalletButton } from '@/components/WalletButton'
import { useDirectory } from '@/privateLending/hooks/useDirectory'
import { useLendingKeyIdentity } from '@/privateLending/hooks/usePrivateFlowDeps'
import { useWallet } from '@/providers/wallet/useWallet'
import { ErrorHandler } from '@/utils/errorHandler'

import DirectorySection from './components/DirectorySection'
import KeyFingerprint from './components/KeyFingerprint'
import LendSection from './components/LendSection'

/** The session's lending key: its fingerprint, its directory name, and the key to share. */
function LendingKeyCard() {
  const identity = useLendingKeyIdentity()
  const { ownEntry } = useDirectory()

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
            <KeyFingerprint
              fingerprint={identity.data.fingerprint}
              name={ownEntry?.display_name}
              size='lg'
            />
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

export default function PrivatePage() {
  const { isReady, reconnecting, privateCapable } = useWallet()

  return (
    <div className='flex flex-col gap-6'>
      <BackLink />

      {(() => {
        if (isReady && privateCapable) {
          return (
            <div className='flex flex-col gap-8'>
              <LendingKeyCard />
              <DirectorySection />
              <LendSection />
            </div>
          )
        }

        if (isReady) {
          return (
            <div className='bg-surface-secondary flex flex-col items-center gap-4 rounded-2xl p-12 text-center'>
              <p className='text-muted'>
                Private loans need Jade or the seed wallet. Disconnect, then connect one of them.
              </p>
            </div>
          )
        }

        if (reconnecting) {
          return (
            <div className='bg-surface-secondary flex flex-col items-center gap-4 rounded-2xl p-12 text-center'>
              <Spinner size='md' />
              <p className='text-muted'>Reconnecting your wallet…</p>
            </div>
          )
        }

        return (
          <div className='bg-surface-secondary flex flex-col items-center gap-4 rounded-2xl p-12 text-center'>
            <p className='text-muted'>Connect your wallet to use private loans.</p>
            <WalletButton />
          </div>
        )
      })()}
    </div>
  )
}
