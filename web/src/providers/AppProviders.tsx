import { ToastProvider } from '@heroui/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { PropsWithChildren } from 'react'

import { AssetDenominationProvider } from './assetDenomination/AssetDenominationProvider'
import { IndexerSubscription } from './indexerEvents/IndexerSubscription'
import { LwkProvider } from './lwk/LwkProvider'
import { PendingTransactionsProvider } from './pendingTransactions/PendingTransactionsProvider'
import { pendingTxToastQueue } from './pendingTransactions/pendingTxToastQueue'
import { queryClient } from './queryClient'
import { TxProgressProvider } from './txProgress/TxProgressProvider'
import { WalletProvider } from './wallet/WalletProvider'

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>
      <LwkProvider>
        <WalletProvider>
          <IndexerSubscription />
          <TxProgressProvider>
            <AssetDenominationProvider>
              <PendingTransactionsProvider>{children}</PendingTransactionsProvider>
            </AssetDenominationProvider>
            <ToastProvider placement='top end' />
            <ToastProvider queue={pendingTxToastQueue} placement='bottom' />
          </TxProgressProvider>
        </WalletProvider>
      </LwkProvider>
    </QueryClientProvider>
  )
}
