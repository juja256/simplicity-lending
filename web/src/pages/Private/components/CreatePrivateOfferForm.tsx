import { Label, ListBox, ListBoxItem, Select } from '@heroui/react'
import { type FormEvent, useMemo, useState } from 'react'

import { useBlockHeight } from '@/api/esplora/hooks'
import KeyFingerprint from '@/components/KeyFingerprint'
import type { PrivateOfferDraft } from '@/components/modals/private/CreatePrivateOfferModal'
import Notice from '@/components/Notice'
import { UiButton } from '@/components/ui/UiButton'
import { UiFieldLabel } from '@/components/ui/UiFieldLabel'
import { UiTextField } from '@/components/ui/UiTextField'
import { NETWORK_CONFIG } from '@/constants/network-config'
import { useFeeRateSatPerKvb } from '@/hooks/useFeeRate'
import { useFormatAmount } from '@/hooks/useFormatAmount'
import { usePolicyAssetUtxos } from '@/hooks/usePolicyAssetUtxos'
import { useDirectory } from '@/privateLending/hooks/useDirectory'
import { useFingerprintOf, X_ONLY_KEY_HEX } from '@/privateLending/hooks/useFingerprintOf'
import { pickCreationCoins } from '@/privateLending/wallet'
import type { PolicyAssetDenomination } from '@/providers/assetDenomination/constants'
import { toBigintAmount } from '@/utils/bigint'
import { formatTermLeft } from '@/utils/format'
import { parsePolicyAssetInput } from '@/utils/policyAssetDenomination'

/** The longest expiry offered, in blocks: about a year of one-minute blocks. */
const MAX_EXPIRY_BLOCKS = 525_600
/** The builder's limit: the interest rate in the terms is at most 0xffff basis points. */
const MAX_INTEREST_BPS = 0xffffn

type Lender = PrivateOfferDraft['lender']

interface Field<T> {
  value: T | null
  error: string | null
}

const EMPTY: Field<never> = { value: null, error: null }

function collateralField(raw: string, denomination: PolicyAssetDenomination): Field<bigint> {
  if (raw.trim() === '') return EMPTY
  const value = parsePolicyAssetInput(raw, denomination)
  if (value === null) {
    return {
      value: null,
      error: denomination === 'sats' ? 'Enter a whole number of sats.' : 'Enter a valid amount.',
    }
  }
  return value > 0n ? { value, error: null } : { value: null, error: 'Enter a positive amount.' }
}

function principalField(raw: string): Field<bigint> {
  const { decimals } = NETWORK_CONFIG.principalAsset
  const text = raw.trim()
  if (text === '') return EMPTY
  if (!new RegExp(`^\\d+(\\.\\d{0,${decimals}})?$`).test(text)) {
    return { value: null, error: `Enter an amount with at most ${decimals} decimals.` }
  }
  const value = toBigintAmount(text, decimals)
  return value > 0n ? { value, error: null } : { value: null, error: 'Enter a positive amount.' }
}

function repaymentField(raw: string, principal: bigint | null): Field<bigint> {
  const field = principalField(raw)
  if (field.value === null || principal === null) return field
  if (field.value < principal) {
    return { value: null, error: 'The repayment cannot be below the principal.' }
  }
  if (((field.value - principal) * 10_000n) / principal > MAX_INTEREST_BPS) {
    return { value: null, error: 'The interest cannot exceed 655.35 % of the principal.' }
  }
  return field
}

function expiryField(raw: string): Field<number> {
  const text = raw.trim()
  if (text === '') return EMPTY
  const blocks = /^\d+$/.test(text) ? Number(text) : NaN
  if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > MAX_EXPIRY_BLOCKS) {
    return {
      value: null,
      error: `Enter a whole number of blocks, 1 to ${MAX_EXPIRY_BLOCKS.toLocaleString('en-US')}.`,
    }
  }
  return { value: blocks, error: null }
}

interface CreatePrivateOfferFormProps {
  /** Opens the review of the offer, where the borrower signs it. */
  onReview: (draft: PrivateOfferDraft) => void
}

/**
 * The borrower's new private offer: the lender (picked from the directory or pasted as a key, and
 * shown by its fingerprint), the amounts, and the expiry in blocks from the tip. The coins are
 * picked again, after a wallet sync, when the offer is built.
 */
export default function CreatePrivateOfferForm({ onReview }: CreatePrivateOfferFormProps) {
  const { collateralAsset, principalAsset } = NETWORK_CONFIG
  const { entries, lookup, own } = useDirectory()
  const fingerprintOf = useFingerprintOf()
  const { data: tipHeight } = useBlockHeight()
  const { utxos: coins, isLoading: coinsLoading } = usePolicyAssetUtxos(true)
  const feeRate = useFeeRateSatPerKvb(true)
  const { denomination, collateralUnit, formatPrincipalAmount } = useFormatAmount()

  const [listedKey, setListedKey] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')
  const [collateralText, setCollateralText] = useState('')
  const [principalText, setPrincipalText] = useState('')
  const [repaymentText, setRepaymentText] = useState('')
  const [expiryText, setExpiryText] = useState('')

  // Directory entries are untrusted: only valid keys are offered, never the wallet's own.
  const listed = useMemo<Lender[]>(
    () =>
      entries.flatMap(entry => {
        const pubkey = entry.pubkey.toLowerCase()
        const fingerprint = fingerprintOf(pubkey)
        return fingerprint && pubkey !== own?.pubkey
          ? [{ pubkey, fingerprint, name: entry.display_name }]
          : []
      }),
    [entries, fingerprintOf, own?.pubkey],
  )

  // A pasted key wins over the directory pick; picking from the directory clears it.
  const pastedKey = pasted.trim().toLowerCase()
  let lender: Lender | null = null
  let lenderError: string | null = null
  if (pastedKey !== '') {
    const fingerprint = fingerprintOf(pastedKey)
    if (!X_ONLY_KEY_HEX.test(pastedKey)) {
      lenderError = 'A lending key is 64 hexadecimal characters.'
    } else if (fingerprint === null) {
      lenderError = 'This is not a valid lending key.'
    } else if (pastedKey === own?.pubkey) {
      lenderError = 'This is your own lending key.'
    } else if (fingerprint !== undefined) {
      lender = { pubkey: pastedKey, fingerprint, name: lookup(pastedKey)?.display_name }
    }
  } else if (listedKey !== null) {
    lender = listed.find(entry => entry.pubkey === listedKey) ?? null
  }

  const collateral = collateralField(collateralText, denomination)
  const principal = principalField(principalText)
  const repayment = repaymentField(repaymentText, principal.value)
  const expiry = expiryField(expiryText)
  const interest =
    principal.value !== null && repayment.value !== null ? repayment.value - principal.value : null

  // Advisory only: the build syncs the wallet and picks the coins again.
  const coinProblem = useMemo(() => {
    if (coinsLoading) return null
    try {
      pickCreationCoins(coins, coin => coin.value, collateral.value ?? 1n, feeRate)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }, [coins, coinsLoading, collateral.value, feeRate])

  const draft: PrivateOfferDraft | null =
    lender !== null &&
    collateral.value !== null &&
    principal.value !== null &&
    repayment.value !== null &&
    expiry.value !== null &&
    tipHeight > 0 &&
    coinProblem === null &&
    !coinsLoading
      ? {
          lender,
          collateralAmount: collateral.value,
          principalAmount: principal.value,
          repaymentAmount: repayment.value,
          loanExpirationTime: tipHeight + expiry.value,
        }
      : null

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (draft) onReview(draft)
  }

  return (
    <form className='bg-surface flex flex-col gap-4 rounded-2xl p-4' onSubmit={submit}>
      <h3 className='text-foreground text-sm font-semibold'>New private offer</h3>

      <div className='grid gap-4 sm:grid-cols-2'>
        <Select
          aria-label='Lender from the directory'
          placeholder={listed.length === 0 ? 'No one is listed yet' : 'Choose a listed lender'}
          isDisabled={listed.length === 0}
          value={pastedKey === '' ? listedKey : null}
          onChange={key => {
            setListedKey(key === null ? null : String(key))
            setPasted('')
          }}
        >
          <Label>Lender from the directory</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox items={listed}>
              {(entry: Lender) => (
                <ListBoxItem
                  id={entry.pubkey}
                  textValue={`${entry.name ?? ''} ${entry.fingerprint}`}
                >
                  <KeyFingerprint fingerprint={entry.fingerprint} name={entry.name} />
                </ListBoxItem>
              )}
            </ListBox>
          </Select.Popover>
        </Select>
        <UiTextField
          aria-label='Or paste a lending key'
          label='Or paste a lending key'
          placeholder='64 hexadecimal characters'
          value={pasted}
          onChange={setPasted}
          errorMessage={lenderError}
          autoComplete='off'
          spellCheck='false'
        />
      </div>

      <div className='bg-surface-secondary flex flex-col gap-1 rounded-xl px-4 py-3'>
        <span className='text-muted text-xs'>Lender</span>
        {lender ? (
          <>
            <KeyFingerprint fingerprint={lender.fingerprint} name={lender.name} size='lg' />
            <span className='text-muted text-xs'>
              Compare this fingerprint with the lender before you create the offer: only this key
              can read it and accept it.
            </span>
          </>
        ) : (
          <span className='text-muted text-sm'>Pick a lender or paste its lending key.</span>
        )}
      </div>

      <div className='grid gap-4 sm:grid-cols-2'>
        <UiTextField
          aria-label='Collateral'
          label={
            <UiFieldLabel
              required
              tooltip={`The ${collateralAsset.symbol} you lock in the offer. You get it back when you repay the loan or cancel the offer; the lender takes it if the loan expires unpaid.`}
            >
              Collateral
            </UiFieldLabel>
          }
          placeholder={denomination === 'sats' ? '0' : '0.00'}
          value={collateralText}
          onChange={setCollateralText}
          endContent={collateralUnit}
          errorMessage={collateral.error}
        />
        <UiTextField
          aria-label='Expiry in blocks'
          label={
            <UiFieldLabel
              required
              tooltip='Blocks from the current tip until the loan expires. After that the lender can take the collateral of an unpaid loan.'
            >
              Expiry
            </UiFieldLabel>
          }
          placeholder='1440'
          value={expiryText}
          onChange={setExpiryText}
          endContent='blocks'
          errorMessage={expiry.error}
          description={
            expiry.value === null
              ? undefined
              : tipHeight > 0
                ? `Block #${tipHeight + expiry.value} (${formatTermLeft(expiry.value)})`
                : 'Waiting for the chain tip…'
          }
        />
        <UiTextField
          aria-label='Principal'
          label={
            <UiFieldLabel
              required
              tooltip={`The ${principalAsset.symbol} you borrow, paid to you when the lender accepts.`}
            >
              Principal
            </UiFieldLabel>
          }
          placeholder='0.00'
          value={principalText}
          onChange={setPrincipalText}
          endContent={principalAsset.symbol}
          errorMessage={principal.error}
        />
        <UiTextField
          aria-label='Repayment'
          label={
            <UiFieldLabel
              required
              tooltip={`The ${principalAsset.symbol} you pay back to unlock your collateral: the principal plus the interest.`}
            >
              Repayment
            </UiFieldLabel>
          }
          placeholder='0.00'
          value={repaymentText}
          onChange={setRepaymentText}
          endContent={principalAsset.symbol}
          errorMessage={repayment.error}
        />
      </div>

      <div className='flex items-center justify-between gap-3 text-sm'>
        <span className='text-muted'>Interest (repayment − principal)</span>
        <span className='text-foreground font-medium tabular-nums'>
          {interest === null ? '—' : formatPrincipalAmount(interest)}
        </span>
      </div>

      {coinProblem && <Notice>{coinProblem}</Notice>}

      <UiButton type='submit' variant='primary' className='self-start' isDisabled={draft === null}>
        Review Offer
      </UiButton>
    </form>
  )
}
