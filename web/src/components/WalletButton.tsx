import { buttonVariants, Chip, Dropdown, Spinner, Tabs } from '@heroui/react'
import { useState } from 'react'

import CopyButton from '@/components/CopyButton'
import { ConnectWalletModal } from '@/components/modals/ConnectWalletModal'
import { UiButton } from '@/components/ui/UiButton'
import { NETWORK_CONFIG } from '@/constants/network-config'
import type { PolicyAssetDenomination } from '@/providers/assetDenomination/constants'
import { useAssetDenomination } from '@/providers/assetDenomination/useAssetDenomination'
import { useLwk } from '@/providers/lwk/useLwk'
import type { WalletSignerType } from '@/providers/wallet/types'
import { useWallet } from '@/providers/wallet/useWallet'
import { truncateAddress } from '@/utils/format'

const NETWORK_LABEL: Record<'liquidtestnet' | 'regtest', string> = {
  liquidtestnet: 'Testnet',
  regtest: 'Regtest',
}

const SIGNER_NAME: Record<WalletSignerType, string> = {
  jade: 'Jade',
  seed: 'Seed phrase',
  sideswap: 'SideSwap',
  humid: 'Humid',
}

interface WalletButtonProps {
  isDisabled?: boolean
  /** Name the connected signer ("Jade") on the button instead of the receive address. */
  showSigner?: boolean
}

export function WalletButton({ isDisabled, showSigner }: WalletButtonProps = {}) {
  const {
    connectionStatus,
    syncing,
    currentReceiveAddress,
    signerType,
    disconnect,
    reconnecting,
    pendingRequest,
  } = useWallet()
  const { network, isMainnet } = useLwk()
  const [disconnecting, setDisconnecting] = useState(false)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isConnectModalOpen, setIsConnectModalOpen] = useState(false)
  const { denomination, setDenomination } = useAssetDenomination()

  const handleDisconnect = async () => {
    setDisconnecting(true)
    try {
      await disconnect({ cachePolicy: 'clear' })
    } finally {
      setDisconnecting(false)
      setIsMenuOpen(false)
    }
  }

  if (reconnecting) {
    return (
      <UiButton variant='secondary' isDisabled>
        Reconnecting…
      </UiButton>
    )
  }

  if (connectionStatus === 'locked') {
    return (
      <UiButton variant='secondary' isDisabled>
        Enter PIN on device
      </UiButton>
    )
  }

  // Read on every render, not kept from connect: a scan or a broadcast that used the address
  // re-renders the button, which then shows the next unused one.
  const receiveAddress = connectionStatus === 'ready' ? currentReceiveAddress() : null

  if (receiveAddress) {
    return (
      <Dropdown.Root isOpen={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <Dropdown.Trigger className={buttonVariants({ variant: 'secondary' })}>
          {showSigner && signerType ? SIGNER_NAME[signerType] : truncateAddress(receiveAddress)}
        </Dropdown.Trigger>
        <Dropdown.Popover placement='bottom end' className='p-4'>
          <div className='flex flex-col gap-3'>
            {!isMainnet && (
              <Chip color='warning' variant='soft' size='sm' className='self-start'>
                {NETWORK_LABEL[network as 'liquidtestnet' | 'regtest']}
              </Chip>
            )}
            <div className='bg-surface-secondary flex items-center justify-between gap-2 rounded-lg p-1 px-2'>
              <span className='font-mono text-xs'>{truncateAddress(receiveAddress)}</span>
              <CopyButton value={receiveAddress} aria-label='Copy address' />
            </div>
            <div className='flex flex-col gap-1.5'>
              <span className='text-muted text-[11px] font-semibold tracking-wide'>
                Balance unit
              </span>
              <Tabs.Root
                aria-label='Balance unit'
                selectedKey={denomination}
                onSelectionChange={key => setDenomination(key as PolicyAssetDenomination)}
                variant='secondary'
              >
                <Tabs.List className='bg-surface-secondary grid w-full grid-cols-2 rounded-xl p-1'>
                  <Tabs.Tab
                    id='lbtc'
                    className='text-muted hover:text-foreground data-[selected]:bg-surface data-[selected]:text-foreground data-[selected]:shadow-sm justify-center rounded-lg px-3 py-2 text-sm font-semibold transition'
                  >
                    {NETWORK_CONFIG.collateralAsset.symbol}
                  </Tabs.Tab>
                  <Tabs.Tab
                    id='sats'
                    className='text-muted hover:text-foreground data-[selected]:bg-surface data-[selected]:text-foreground data-[selected]:shadow-sm justify-center rounded-lg px-3 py-2 text-sm font-semibold transition'
                  >
                    {NETWORK_CONFIG.policyAssetSatsUnit}
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs.Root>
            </div>
            <UiButton
              variant='danger'
              fullWidth
              className='rounded-lg'
              isPending={disconnecting}
              loadingText='Disconnecting…'
              onPress={handleDisconnect}
            >
              Disconnect
            </UiButton>
          </div>
        </Dropdown.Popover>
      </Dropdown.Root>
    )
  }

  return (
    <>
      {(() => {
        if (syncing && connectionStatus !== 'ready') {
          if (pendingRequest) {
            return (
              <UiButton variant='secondary' onPress={() => setIsConnectModalOpen(true)}>
                <Spinner size='sm' color='current' aria-hidden />
                Connecting…
              </UiButton>
            )
          }
          return (
            <UiButton variant='secondary' isDisabled isPending loadingText='Connecting…'>
              Connecting…
            </UiButton>
          )
        }

        return (
          <UiButton
            variant='primary'
            isDisabled={isDisabled}
            onPress={() => setIsConnectModalOpen(true)}
          >
            Connect Wallet
          </UiButton>
        )
      })()}
      <ConnectWalletModal isOpen={isConnectModalOpen} onOpenChange={setIsConnectModalOpen} />
    </>
  )
}
