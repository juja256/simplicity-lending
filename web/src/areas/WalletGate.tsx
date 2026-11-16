import { Spinner } from '@heroui/react'
import type { ReactNode } from 'react'

import { WalletButton } from '@/components/WalletButton'
import { env } from '@/constants/env'
import { useWallet } from '@/providers/wallet/useWallet'

function GateMessage({ children }: { children: ReactNode }) {
  return (
    <div className='bg-surface-secondary flex flex-col items-center gap-4 rounded-2xl px-4 py-12 text-center sm:px-12'>
      {children}
    </div>
  )
}

/**
 * Shows its children once a wallet that can run private loans is connected, and otherwise the
 * wallet's state: reconnecting, a wallet that cannot do private loans, or the connect button.
 */
export function WalletGate({ children }: { children: ReactNode }) {
  const { isReady, reconnecting, privateCapable } = useWallet()

  if (isReady && privateCapable) return <>{children}</>

  if (isReady) {
    return (
      <GateMessage>
        <p className='text-muted'>
          Private loans need Jade{env.VITE_DEMO_MODE ? ' or a test-seed wallet' : ''}. Disconnect,
          then connect a supported wallet.
        </p>
      </GateMessage>
    )
  }

  if (reconnecting) {
    return (
      <GateMessage>
        <Spinner size='md' aria-hidden />
        <p role='status' className='text-muted'>
          Reconnecting your wallet…
        </p>
      </GateMessage>
    )
  }

  return (
    <GateMessage>
      <p className='text-muted'>Connect your wallet to use private loans.</p>
      <WalletButton />
    </GateMessage>
  )
}
