import { toast } from '@heroui/react'
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router-dom'

import Notice from '@/components/Notice'
import PairTermsSummary from '@/components/PairTermsSummary'
import { UiButton } from '@/components/ui/UiButton'
import { UiTextField } from '@/components/ui/UiTextField'
import { NETWORK_CONFIG } from '@/constants/network-config'
import { RoutePath } from '@/constants/routes'
import { type OwnEntry, useDirectory } from '@/privateLending/hooks/useDirectory'
import {
  EMPTY_PAIR_TERMS_FORM,
  findPairTerms,
  formatPublishedAt,
  lenderTermsFromForm,
  MAX_TERM_DAYS,
  otherPairs,
  type PairTermsForm,
  pairTermsToForm,
  type TermsPair,
  termsToPublish,
} from '@/privateLending/lenderTerms'
import { ErrorHandler } from '@/utils/errorHandler'

import { displayNameError, MAX_DISPLAY_NAME_CHARS } from './displayName'
import OwnEntryPending from './OwnEntryPending'

const { collateralAsset: COLLATERAL, principalAsset: PRINCIPAL } = NETWORK_CONFIG
const PAIR: TermsPair = { collateral: COLLATERAL, principal: PRINCIPAL }

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

/** The verified entry's pairs for other assets, which a publish signs again unchanged. */
function keptPairsNote(count: number): string {
  const pairs = count === 1 ? 'another pair' : `${count} other pairs`
  return `Your entry also has terms for ${pairs}. Publishing keeps them as they are.`
}

type RegisterMutation = ReturnType<typeof useDirectory>['register']

interface TermsEditorProps {
  own: OwnEntry
  register: RegisterMutation
}

/**
 * The configured pair's terms form, pre-filled from the wallet's entry only when it verified. A
 * publish signs the name with the terms: the verified entry's name, or the one typed here when
 * there is none (a first publish, or an entry that did not verify).
 */
function TermsEditor({ own, register }: TermsEditorProps) {
  const verified = own.entry !== null && own.check?.status === 'verified' ? own.check.terms : null
  const verifiedName = verified !== null ? own.entry?.display_name : undefined
  const isUnverified = own.entry !== null && verified === null

  const [name, setName] = useState('')
  // Nothing the indexer serves pre-fills the form unless the key signed it.
  const [termsForm, setTermsForm] = useState<PairTermsForm>(() => {
    const published = findPairTerms(verified, PAIR)
    return published ? pairTermsToForm(published, PAIR) : EMPTY_PAIR_TERMS_FORM
  })

  const displayName = verifiedName ?? name
  const nameError = name === '' ? null : displayNameError(name)
  const parsed = lenderTermsFromForm(termsForm, PAIR)
  const keptPairs = otherPairs(verified, PAIR).length
  const canPublish = displayNameError(displayName) === null && parsed.terms !== null

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canPublish || parsed.terms === null || register.isPending) return
    register.mutate(
      { displayName, terms: termsToPublish(parsed.terms, verified, PAIR) },
      { onSuccess: () => toast.success('Terms published') },
    )
  }

  return (
    <div className='grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]'>
      <form className='flex flex-col gap-5' onSubmit={submit}>
        {isUnverified ? (
          <Notice>
            Your directory entry could not be verified against your key, so borrowers do not see it.
            Sign and publish your terms again to replace it.
          </Notice>
        ) : own.entry === null ? (
          <p className='text-muted text-sm'>
            You have not published terms yet. Borrowers find you once you do.
          </p>
        ) : (
          <p className='text-muted text-sm'>
            Last published{' '}
            {own.entry.terms_published_at === null
              ? 'at an unknown time'
              : formatPublishedAt(own.entry.terms_published_at)}
            , as <bdi className='text-foreground font-medium'>{verifiedName}</bdi>. Change the name
            on your{' '}
            <Link to={RoutePath.LendProfile} className='text-accent hover:underline'>
              profile
            </Link>
            .
          </p>
        )}

        {verifiedName === undefined && (
          <UiTextField
            label='Display name'
            placeholder='Your name in the directory'
            value={name}
            onChange={setName}
            isDisabled={register.isPending}
            errorMessage={nameError}
            description={`Published with your terms. 1 to ${MAX_DISPLAY_NAME_CHARS} characters, without leading or trailing spaces.`}
          />
        )}

        <fieldset className='flex flex-col gap-3'>
          <legend className='text-foreground mb-3 text-sm font-semibold'>
            {PRINCIPAL.symbol} against {COLLATERAL.symbol}
          </legend>
          <div className='grid gap-3 sm:grid-cols-2'>
            {TERMS_FIELDS.map(({ field, label, placeholder, unit }) => (
              <UiTextField
                key={field}
                label={label}
                placeholder={placeholder}
                value={termsForm[field]}
                onChange={value => setTermsForm(form => ({ ...form, [field]: value }))}
                isDisabled={register.isPending}
                endContent={unit}
                errorMessage={termsForm[field] === '' ? null : parsed.errors?.[field]}
              />
            ))}
          </div>
          {keptPairs > 0 && <p className='text-muted text-xs'>{keptPairsNote(keptPairs)}</p>}
        </fieldset>

        {register.error && (
          <Notice tone='danger' role='alert'>
            Your terms were not published: {ErrorHandler.describe(register.error)}
          </Notice>
        )}

        <div>
          <UiButton
            type='submit'
            variant='primary'
            isDisabled={!canPublish}
            isPending={register.isPending}
            loadingText='Signing…'
          >
            Sign and publish
          </UiButton>
        </div>
      </form>

      <aside className='bg-background flex h-fit flex-col gap-3 rounded-2xl p-4'>
        <h2 className='text-foreground text-sm font-semibold'>What borrowers see</h2>
        <PairTermsSummary
          verifiedTerms={verified}
          publishedAt={own.entry?.terms_published_at ?? null}
        />
      </aside>
    </div>
  )
}

/**
 * The lender's terms for the configured pair: what borrowers propose within, and what each
 * proposal is checked against. Publishing signs them with the lending key, with the display name.
 */
export default function TermsPage() {
  const { identity, own, ownQuery, register } = useDirectory()

  return (
    <div className='flex flex-col gap-6'>
      <header className='flex flex-col gap-1'>
        <h1 className='text-foreground text-2xl font-semibold'>Terms</h1>
        <p className='text-muted text-sm'>
          What you lend, against what, and at what price. Borrowers propose within these terms, and
          each proposal shows how it compares with them.
        </p>
      </header>

      {own === undefined ? (
        <OwnEntryPending ownQuery={ownQuery} />
      ) : (
        <TermsEditor key={identity?.pubkey} own={own} register={register} />
      )}
    </div>
  )
}
