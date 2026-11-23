import { type ConfigAsset, NETWORK_CONFIG } from '@/constants/network-config'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { useWallet } from '@/providers/wallet/useWallet'

interface WalletBalancesProps {
  /** `column` for the lender console's sidebar, `row` for the borrower app's header. */
  layout?: 'column' | 'row'
}

/**
 * The connected wallet's balance of the pair's two assets: confirmed coins, which the flows
 * spend, and beside them what is still unconfirmed. The wallet refreshes them every minute and
 * when the tab regains focus; the collateral follows the wallet menu's balance unit.
 */
export default function WalletBalances({ layout = 'column' }: WalletBalancesProps) {
  const { isReady, confirmedBalances, pendingBalances } = useWallet()
  const { formatCollateralDisplay, formatPrincipalAmount } = useFormatAmount()
  const { collateralAsset, principalAsset } = NETWORK_CONFIG

  // The wallet loads its balances before it is ready, so a missing asset holds nothing.
  if (!isReady) return null

  const rows: { asset: ConfigAsset; format: (amount: bigint) => string }[] = [
    { asset: collateralAsset, format: formatCollateralDisplay },
    { asset: principalAsset, format: formatPrincipalAmount },
  ]

  return (
    <section aria-label='Wallet balance' className='flex min-w-0 flex-col gap-1'>
      <span className='text-muted text-xs'>Wallet balance</span>
      <dl
        className={
          layout === 'row' ? 'flex flex-wrap items-baseline gap-x-6 gap-y-1' : 'flex flex-col gap-1'
        }
      >
        {rows.map(({ asset, format }) => {
          const confirmed = BigInt(confirmedBalances[asset.id] ?? 0)
          const pending = BigInt(pendingBalances[asset.id] ?? 0)
          const Icon = asset.icon
          return (
            <div key={asset.id} className='flex min-w-0 items-center gap-1.5'>
              <dt>
                <Icon className='size-4 shrink-0' aria-hidden />
                <span className='sr-only'>{asset.symbol}</span>
              </dt>
              <dd className='flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm'>
                <span className='text-foreground font-medium whitespace-nowrap tabular-nums'>
                  {format(confirmed)}
                </span>
                {pending !== 0n && (
                  <span
                    className='text-muted text-xs whitespace-nowrap tabular-nums'
                    title='Unconfirmed: spendable once its transaction confirms.'
                  >
                    {pending > 0n ? '+' : '−'}
                    {format(pending > 0n ? pending : -pending)} pending
                  </span>
                )}
              </dd>
            </div>
          )
        })}
      </dl>
    </section>
  )
}
