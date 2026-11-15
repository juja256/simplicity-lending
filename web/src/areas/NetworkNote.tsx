import ArrowSquareOutIcon from '@/components/icons/ArrowSquareOutIcon'
import { env } from '@/constants/env'
import { ExternalLink } from '@/constants/links'

const NETWORK_LABEL = { liquid: 'Liquid', liquidtestnet: 'Liquid testnet', regtest: 'Regtest' }

/** The network the site runs on and, on testnet, where to get test assets. */
export function NetworkNote({ className = '' }: { className?: string }) {
  const testnet = env.VITE_NETWORK === 'liquidtestnet'
  return (
    <div className={`text-muted flex flex-wrap items-center gap-x-3 gap-y-1 text-xs ${className}`}>
      <p>{testnet ? 'Liquid testnet, test assets only' : NETWORK_LABEL[env.VITE_NETWORK]}</p>
      {testnet && (
        <a
          className='text-accent focus-visible:outline-accent inline-flex items-center gap-1 rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2'
          href={ExternalLink.Faucet}
          target='_blank'
          rel='noopener noreferrer'
        >
          Get test assets
          <ArrowSquareOutIcon className='size-3' />
        </a>
      )}
    </div>
  )
}
