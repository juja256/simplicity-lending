import { Chip, Skeleton } from '@heroui/react'
import { type FormEvent, useState } from 'react'

import UserIcon from '@/components/icons/UserIcon'
import KeyFingerprint from '@/components/KeyFingerprint'
import Notice from '@/components/Notice'
import { OffersLoadError } from '@/components/OffersLoadError'
import { UiButton } from '@/components/ui/UiButton'
import { UiTextField } from '@/components/ui/UiTextField'
import { NETWORK_CONFIG } from '@/constants/network-config'
import { useDirectory } from '@/privateLending/hooks/useDirectory'
import { useFingerprintOf } from '@/privateLending/hooks/useFingerprintOf'
import {
  EMPTY_PAIR_TERMS_FORM,
  findPairTerms,
  lenderTermsFromForm,
  MAX_TERM_DAYS,
  otherPairs,
  type PairTermsForm,
  pairTermsToForm,
} from '@/privateLending/lenderTerms'
import { ErrorHandler } from '@/utils/errorHandler'

import { displayNameError, MAX_DISPLAY_NAME_CHARS } from '../helpers'
import PairTermsSummary from './PairTermsSummary'

const { collateralAsset: COLLATERAL, principalAsset: PRINCIPAL } = NETWORK_CONFIG
const PAIR = { collateral: COLLATERAL, principal: PRINCIPAL }

/** The terms form's fields, in their order on the page. */
const TERMS_FIELDS: {
  field: keyof PairTermsForm
  label: string
  placeholder: string
  unit: string
}[] = [
  { field: 'minAprPercent', label: 'Least APR', placeholder: '5', unit: '%' },
  {
    field: 'maxPrincipalPerCollateral',
    label: `Most principal per 1 ${COLLATERAL.symbol}`,
    placeholder: '50000',
    unit: PRINCIPAL.symbol,
  },
  { field: 'minTermDays', label: 'Shortest term', placeholder: '1', unit: 'days' },
  {
    field: 'maxTermDays',
    label: 'Longest term',
    placeholder: String(MAX_TERM_DAYS),
    unit: 'days',
  },
  { field: 'minPrincipal', label: 'Smallest principal', placeholder: '1', unit: PRINCIPAL.symbol },
  {
    field: 'maxPrincipal',
    label: 'Largest principal',
    placeholder: '1000',
    unit: PRINCIPAL.symbol,
  },
]

/** The served entry's pairs for other assets: the form publishes the configured pair alone. */
function droppedPairsNote(count: number): string {
  const pairs = count === 1 ? 'another pair' : `${count} other pairs`
  return (
    `The directory also shows terms for ${pairs} under your key. Saving publishes only ` +
    `${PRINCIPAL.symbol} against ${COLLATERAL.symbol} and drops the rest.`
  )
}

/**
 * The lender directory: the wallet's own entry (register with terms, edit, remove) and every
 * listed key. Names are not verified identities: each shows next to its key's fingerprint.
 */
export default function DirectorySection() {
  const { directory, entries, own, ownEntry, register, remove } = useDirectory()
  const fingerprintOf = useFingerprintOf()

  const [isEditing, setIsEditing] = useState(false)
  const [isConfirmingRemove, setIsConfirmingRemove] = useState(false)
  const [name, setName] = useState('')
  const [termsForm, setTermsForm] = useState<PairTermsForm>(EMPTY_PAIR_TERMS_FORM)
  const nameError = name === '' ? null : displayNameError(name)
  const parsedTerms = lenderTermsFromForm(termsForm, PAIR)
  const droppedPairs = otherPairs(ownEntry?.terms, PAIR).length
  const showForm = ownEntry === null || isEditing

  const resetForm = () => {
    setIsEditing(false)
    setName('')
    setTermsForm(EMPTY_PAIR_TERMS_FORM)
  }

  const startEditing = () => {
    register.reset()
    remove.reset()
    setName(ownEntry?.display_name ?? '')
    const published = findPairTerms(ownEntry?.terms, PAIR)
    setTermsForm(published ? pairTermsToForm(published, PAIR) : EMPTY_PAIR_TERMS_FORM)
    setIsConfirmingRemove(false)
    setIsEditing(true)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (displayNameError(name) !== null || parsedTerms.terms === null || register.isPending) return
    // The configured pair alone, from the form: nothing of the served entry is signed.
    register.mutate({ displayName: name, terms: parsedTerms.terms }, { onSuccess: resetForm })
  }

  const writeError = register.error ?? remove.error

  return (
    <section className='bg-surface-secondary flex flex-col gap-6 rounded-3xl p-6'>
      <header className='flex flex-col gap-1'>
        <div className='flex items-center gap-2'>
          <UserIcon className='size-5' />
          <h2 className='text-foreground text-[11px] font-semibold tracking-wide uppercase'>
            Lender Directory
          </h2>
        </div>
        <p className='text-muted text-sm'>
          Borrowers pick a lender here, or paste its key. Anyone can choose any name, so a name is
          not an identity: compare the key fingerprint with its owner.
        </p>
      </header>

      <div className='bg-surface flex flex-col gap-4 rounded-2xl p-4'>
        <h3 className='text-foreground text-sm font-semibold'>Your entry</h3>

        {ownEntry === undefined ? (
          directory.isError ? (
            <p className='text-muted text-sm'>The directory could not be loaded.</p>
          ) : (
            <Skeleton className='h-10 w-full rounded' />
          )
        ) : showForm ? (
          <form className='flex flex-col gap-3' onSubmit={submit}>
            {ownEntry === null && (
              <p className='text-muted text-sm'>
                You are not listed. Register a name and your terms so that borrowers can find your
                key.
              </p>
            )}
            <UiTextField
              aria-label='Display name'
              label='Display name'
              placeholder='Your name in the directory'
              value={name}
              onChange={setName}
              isDisabled={register.isPending}
              errorMessage={nameError}
              description={`1 to ${MAX_DISPLAY_NAME_CHARS} characters, without leading or trailing spaces.`}
            />
            <h4 className='text-foreground text-xs font-semibold'>
              Your terms for {PRINCIPAL.symbol} against {COLLATERAL.symbol}
            </h4>
            {droppedPairs > 0 && (
              <p className='text-muted text-xs'>{droppedPairsNote(droppedPairs)}</p>
            )}
            <div className='grid gap-3 sm:grid-cols-2'>
              {TERMS_FIELDS.map(({ field, label, placeholder, unit }) => (
                <UiTextField
                  key={field}
                  aria-label={label}
                  label={label}
                  placeholder={placeholder}
                  value={termsForm[field]}
                  onChange={value => setTermsForm(form => ({ ...form, [field]: value }))}
                  isDisabled={register.isPending}
                  endContent={unit}
                  errorMessage={termsForm[field] === '' ? null : parsedTerms.errors?.[field]}
                />
              ))}
            </div>
            <div className='flex flex-wrap gap-2'>
              <UiButton
                type='submit'
                variant='primary'
                size='sm'
                isDisabled={name === '' || nameError !== null || parsedTerms.terms === null}
                isPending={register.isPending}
                loadingText='Signing…'
              >
                {ownEntry === null ? 'Register' : 'Save'}
              </UiButton>
              {isEditing && (
                <UiButton
                  variant='ghost'
                  size='sm'
                  isDisabled={register.isPending}
                  onPress={() => {
                    register.reset()
                    resetForm()
                  }}
                >
                  Cancel
                </UiButton>
              )}
            </div>
          </form>
        ) : (
          <div className='flex flex-wrap items-start justify-between gap-3'>
            <div className='flex min-w-0 flex-col gap-1 text-sm'>
              <span className='text-muted text-xs'>Listed as</span>
              <KeyFingerprint fingerprint={own?.fingerprint ?? ''} name={ownEntry.display_name} />
              <PairTermsSummary terms={ownEntry.terms} publishedAt={ownEntry.terms_published_at} />
              {droppedPairs > 0 && (
                <p className='text-muted text-xs'>{droppedPairsNote(droppedPairs)}</p>
              )}
            </div>
            {isConfirmingRemove ? (
              <div className='flex flex-wrap items-center gap-2'>
                <span className='text-muted text-sm'>Remove your entry?</span>
                <UiButton
                  variant='danger-soft'
                  size='sm'
                  isPending={remove.isPending}
                  loadingText='Signing…'
                  onPress={() =>
                    remove.mutate(undefined, { onSettled: () => setIsConfirmingRemove(false) })
                  }
                >
                  Remove
                </UiButton>
                <UiButton
                  variant='ghost'
                  size='sm'
                  isDisabled={remove.isPending}
                  onPress={() => setIsConfirmingRemove(false)}
                >
                  Keep
                </UiButton>
              </div>
            ) : (
              <div className='flex flex-wrap gap-2'>
                <UiButton variant='secondary' size='sm' onPress={startEditing}>
                  Edit
                </UiButton>
                <UiButton
                  variant='danger-soft'
                  size='sm'
                  onPress={() => {
                    register.reset()
                    remove.reset()
                    setIsConfirmingRemove(true)
                  }}
                >
                  Remove
                </UiButton>
              </div>
            )}
          </div>
        )}

        {writeError && (
          <Notice tone='danger' role='alert'>
            Your entry was not changed: {ErrorHandler.describe(writeError)}
          </Notice>
        )}
      </div>

      <div className='flex flex-col gap-3'>
        <h3 className='text-foreground text-sm font-semibold'>
          Listed keys{directory.isSuccess ? ` (${entries.length})` : ''}
        </h3>
        {directory.isPending ? (
          <div className='flex flex-col gap-1'>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className='h-10 w-full rounded' />
            ))}
          </div>
        ) : directory.isError ? (
          <OffersLoadError error={directory.error} onRetry={() => void directory.refetch()} />
        ) : entries.length === 0 ? (
          <div className='bg-surface border-muted flex h-14 items-center rounded border border-dashed px-4 opacity-50'>
            <span className='text-foreground text-sm font-medium'>No one is listed yet.</span>
          </div>
        ) : (
          <ul className='flex max-h-96 flex-col gap-1 overflow-y-auto'>
            {entries.map(entry => {
              const fingerprint = fingerprintOf(entry.pubkey)
              const isOwn = own !== undefined && entry.pubkey === own.pubkey
              return (
                <li
                  key={entry.pubkey}
                  className='bg-surface flex min-h-10 items-center justify-between gap-3 rounded px-4 py-2 text-sm'
                >
                  {fingerprint ? (
                    <KeyFingerprint fingerprint={fingerprint} name={entry.display_name} />
                  ) : (
                    <span className='text-muted inline-flex items-baseline gap-2'>
                      <bdi className='max-w-64 truncate'>{entry.display_name}</bdi>
                      <span className='text-xs'>
                        {fingerprint === null ? 'not a valid key' : '…'}
                      </span>
                    </span>
                  )}
                  {isOwn && (
                    <Chip color='accent' variant='soft' size='sm'>
                      You
                    </Chip>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
