import { Skeleton, toast } from '@heroui/react'
import { type FormEvent, type ReactNode, useState } from 'react'

import CheckIcon from '@/components/icons/CheckIcon'
import CopyIcon from '@/components/icons/CopyIcon'
import KeyFingerprint from '@/components/KeyFingerprint'
import Notice from '@/components/Notice'
import PairTermsSummary from '@/components/PairTermsSummary'
import { UiButton } from '@/components/ui/UiButton'
import { UiTextField } from '@/components/ui/UiTextField'
import { NETWORK_CONFIG } from '@/constants/network-config'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { type OwnEntry, useDirectory } from '@/privateLending/hooks/useDirectory'
import { useLendingKeyIdentity } from '@/privateLending/hooks/usePrivateFlowDeps'
import {
  formatPublishedAt,
  lenderTermsFromForm,
  MAX_TERM_DAYS,
  otherPairs,
  type PairTermsForm,
  type TermsPair,
  termsToPublish,
} from '@/privateLending/lenderTerms'
import { ErrorHandler } from '@/utils/errorHandler'

import { displayNameError, MAX_DISPLAY_NAME_CHARS } from './displayName'
import OwnEntryPending from './OwnEntryPending'
import { termsFormOf, verifiedOwnTerms } from './termsForm'

type Directory = ReturnType<typeof useDirectory>

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

function ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className='border-separator flex flex-col gap-3 border-t pt-6'>
      <h2 className='text-foreground text-base font-semibold'>{title}</h2>
      {children}
    </section>
  )
}

/** The session's lending key: its fingerprint, the whole x-only key, and "Copy key". */
function LendingKey({ name }: { name: string | undefined }) {
  const identity = useLendingKeyIdentity()
  const [copied, copy] = useCopyToClipboard()

  if (identity.isError) {
    return (
      <Notice tone='danger' role='alert'>
        Your lending key could not be derived: {ErrorHandler.describe(identity.error)}
      </Notice>
    )
  }
  if (identity.data === undefined) return <Skeleton className='h-16 w-full rounded' />

  const { fingerprint, pubkey } = identity.data
  return (
    <div className='flex flex-col gap-3'>
      <KeyFingerprint fingerprint={fingerprint} name={name} size='lg' />
      <p className='text-muted font-mono text-xs break-all'>{pubkey}</p>
      <div>
        <UiButton variant='secondary' size='sm' onPress={() => copy(pubkey)}>
          {copied ? <CheckIcon className='size-4' /> : <CopyIcon className='size-4' />}
          {copied ? 'Copied' : 'Copy key'}
        </UiButton>
      </div>
    </div>
  )
}

interface EntryEditorProps {
  own: OwnEntry
  register: Directory['register']
}

/**
 * The directory entry's name and the configured pair's terms, in one form: the key signs them
 * together, so one publish changes either or both. The form opens on the wallet's entry only when
 * it verified against the key; otherwise both start empty.
 */
function EntryEditor({ own, register }: EntryEditorProps) {
  const verified = verifiedOwnTerms(own)
  const verifiedName = verified !== null ? own.entry?.display_name : undefined
  const isUnverified = own.entry !== null && verified === null

  // Nothing the indexer serves pre-fills the form unless the key signed it.
  const [name, setName] = useState(verifiedName ?? '')
  const [termsForm, setTermsForm] = useState<PairTermsForm>(() => termsFormOf(own, PAIR))

  const nameError = name === '' ? null : displayNameError(name)
  const parsed = lenderTermsFromForm(termsForm, PAIR)
  const keptPairs = otherPairs(verified, PAIR).length
  const canPublish = displayNameError(name) === null && parsed.terms !== null

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canPublish || parsed.terms === null || register.isPending) return
    register.mutate(
      { displayName: name, terms: termsToPublish(parsed.terms, verified, PAIR) },
      { onSuccess: () => toast.success('Profile published') },
    )
  }

  return (
    <div className='grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]'>
      <form className='flex flex-col gap-5' onSubmit={submit}>
        {isUnverified ? (
          <Notice>
            Your directory entry could not be verified against your key, so borrowers do not see it.
            Sign and publish your name and terms again to replace it.
          </Notice>
        ) : own.entry === null ? (
          <p className='text-muted text-sm'>
            You have not published a name and terms yet. Borrowers find you once you do.
          </p>
        ) : (
          <p className='text-muted text-sm'>
            Last published{' '}
            {own.entry.terms_published_at === null
              ? 'at an unknown time'
              : formatPublishedAt(own.entry.terms_published_at)}
            , as <bdi className='text-foreground font-medium'>{verifiedName}</bdi>.
          </p>
        )}

        <UiTextField
          label='Display name'
          placeholder='Your name in the directory'
          value={name}
          onChange={setName}
          isDisabled={register.isPending}
          errorMessage={nameError}
          description={`1 to ${MAX_DISPLAY_NAME_CHARS} characters, without leading or trailing spaces. Anyone can choose any name: borrowers compare your key fingerprint.`}
        />

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
            Your name and terms were not published: {ErrorHandler.describe(register.error)}
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
        <PairTermsSummary verifiedTerms={verified} unverified={isUnverified} />
      </aside>
    </div>
  )
}

/** The entry's place in the directory, and its removal behind a confirmation. */
function DirectoryListing({ own, remove }: { own: OwnEntry; remove: Directory['remove'] }) {
  const [isConfirming, setIsConfirming] = useState(false)

  if (own.entry === null) {
    return <p className='text-muted text-sm'>You are not in the directory.</p>
  }

  const removeEntry = () =>
    remove.mutate(undefined, {
      onSuccess: () => toast.success('Removed from directory'),
      onSettled: () => setIsConfirming(false),
    })

  return (
    <div className='flex flex-col gap-3'>
      <p className='text-muted text-sm'>
        {own.check?.status === 'verified'
          ? 'Borrowers see you in their list of lenders, with your terms.'
          : 'You are listed, but borrowers do not see you: your entry could not be verified.'}
      </p>
      {isConfirming ? (
        <div className='bg-background flex flex-col gap-3 rounded-2xl p-4'>
          <p className='text-foreground text-sm'>
            Remove your entry? Borrowers will no longer see you in their list of lenders. Proposals
            and loans already made are not affected.
          </p>
          <div className='flex flex-wrap gap-2'>
            <UiButton
              variant='danger'
              size='sm'
              isPending={remove.isPending}
              loadingText='Signing…'
              onPress={removeEntry}
            >
              Remove from directory
            </UiButton>
            <UiButton
              variant='ghost'
              size='sm'
              isDisabled={remove.isPending}
              onPress={() => setIsConfirming(false)}
            >
              Keep listed
            </UiButton>
          </div>
        </div>
      ) : (
        <div>
          <UiButton
            variant='danger-soft'
            size='sm'
            onPress={() => {
              remove.reset()
              setIsConfirming(true)
            }}
          >
            Remove from directory
          </UiButton>
        </div>
      )}
      {remove.error && (
        <Notice tone='danger' role='alert'>
          Your entry was not removed: {ErrorHandler.describe(remove.error)}
        </Notice>
      )}
    </div>
  )
}

/**
 * The lender's profile: its lending key, and the directory entry that lists it for borrowers, its
 * display name and its terms for the configured pair, which the key signs together. Borrowers
 * propose within the terms, and each proposal is checked against them.
 */
export default function ProfilePage() {
  const { identity: entryKey, own, ownQuery, register, remove } = useDirectory({ ownEntry: true })
  const identity = useLendingKeyIdentity()
  // The name the key signed: an entry that did not verify shows the fingerprint alone.
  const verifiedName = own?.check?.status === 'verified' ? own.entry?.display_name : undefined

  return (
    <div className='flex flex-col gap-6'>
      <header className='flex flex-col gap-1'>
        <h1 className='text-foreground text-2xl font-semibold'>Profile</h1>
        <p className='text-muted max-w-2xl text-sm'>
          Borrowers address proposals to your lending key, and find you by the name and terms your
          directory entry publishes for it. Anyone can choose any name, so a name is not an
          identity: share your key fingerprint with borrowers so they can compare it.
        </p>
      </header>

      <ProfileSection title='Lending key'>
        <LendingKey name={verifiedName} />
      </ProfileSection>

      {/* Without the key there is no entry to read: the key's section above says why, once. */}
      {!identity.isError && (
        <ProfileSection title='Name and terms'>
          <p className='text-muted max-w-2xl text-sm'>
            What you lend, against what, and at what price. Borrowers propose within these terms,
            and each proposal shows how it compares with them. Your key signs the name and the terms
            together.
          </p>
          {own === undefined ? (
            <OwnEntryPending ownQuery={ownQuery} />
          ) : (
            <EntryEditor key={entryKey?.pubkey} own={own} register={register} />
          )}
        </ProfileSection>
      )}

      {own !== undefined && (
        <ProfileSection title='Directory'>
          <DirectoryListing own={own} remove={remove} />
        </ProfileSection>
      )}
    </div>
  )
}
