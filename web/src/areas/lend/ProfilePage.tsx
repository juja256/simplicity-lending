import { Skeleton, toast } from '@heroui/react'
import { type FormEvent, type ReactNode, useState } from 'react'
import { Link } from 'react-router-dom'

import CheckIcon from '@/components/icons/CheckIcon'
import CopyIcon from '@/components/icons/CopyIcon'
import KeyFingerprint from '@/components/KeyFingerprint'
import Notice from '@/components/Notice'
import { UiButton } from '@/components/ui/UiButton'
import { UiTextField } from '@/components/ui/UiTextField'
import { RoutePath } from '@/constants/routes'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { type OwnEntry, useDirectory } from '@/privateLending/hooks/useDirectory'
import { useLendingKeyIdentity } from '@/privateLending/hooks/usePrivateFlowDeps'
import type { LenderTermsInput } from '@/privateLending/lenderTerms'
import { ErrorHandler } from '@/utils/errorHandler'

import { displayNameError, MAX_DISPLAY_NAME_CHARS } from './displayName'
import OwnEntryPending from './OwnEntryPending'

type Directory = ReturnType<typeof useDirectory>

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

interface NameFormProps {
  name: string
  terms: LenderTermsInput
  register: Directory['register']
}

/** Changes the display name by signing it again with the lender's verified terms, unchanged. */
function NameForm({ name: publishedName, terms, register }: NameFormProps) {
  const [name, setName] = useState(publishedName)
  const nameError = name === '' ? null : displayNameError(name)
  const canPublish = name !== publishedName && displayNameError(name) === null

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canPublish || register.isPending) return
    register.mutate(
      { displayName: name, terms },
      { onSuccess: () => toast.success('Name published') },
    )
  }

  return (
    <form className='flex flex-col gap-3' onSubmit={submit}>
      <UiTextField
        label='Display name'
        value={name}
        onChange={setName}
        isDisabled={register.isPending}
        errorMessage={nameError}
        description={`1 to ${MAX_DISPLAY_NAME_CHARS} characters, without leading or trailing spaces. Your name is signed with your terms: publishing it signs your current terms again, unchanged.`}
      />
      {register.error && (
        <Notice tone='danger' role='alert'>
          Your name was not published: {ErrorHandler.describe(register.error)}
        </Notice>
      )}
      <div>
        <UiButton
          type='submit'
          variant='primary'
          size='sm'
          isDisabled={!canPublish}
          isPending={register.isPending}
          loadingText='Signing…'
        >
          Publish name
        </UiButton>
      </div>
    </form>
  )
}

/** The name, when the entry verified; otherwise a pointer to the terms it is published with. */
function DisplayName({ own, register }: { own: OwnEntry; register: Directory['register'] }) {
  if (own.entry !== null && own.check?.status === 'verified') {
    return (
      <NameForm
        key={own.entry.display_name}
        name={own.entry.display_name}
        terms={own.check.terms}
        register={register}
      />
    )
  }
  const link = (
    <Link to={RoutePath.LendTerms} className='text-accent hover:underline'>
      Publish your terms
    </Link>
  )
  return own.entry === null ? (
    <p className='text-muted text-sm'>
      Your name is published with your terms, and you have not published any yet. {link} with a name
      first.
    </p>
  ) : (
    <p className='text-muted text-sm'>
      Your directory entry could not be verified against your key, so its name is not shown. {link}{' '}
      again with a name to replace it.
    </p>
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
 * How borrowers know the lender: its lending key, and the display name its directory entry shows
 * next to it. A name is chosen by whoever holds a key, so borrowers compare the fingerprint.
 */
export default function ProfilePage() {
  const { own, ownQuery, register, remove } = useDirectory({ ownEntry: true })
  // The name the key signed: an entry that did not verify shows the fingerprint alone.
  const verifiedName = own?.check?.status === 'verified' ? own.entry?.display_name : undefined

  return (
    <div className='flex max-w-2xl flex-col gap-6'>
      <header className='flex flex-col gap-1'>
        <h1 className='text-foreground text-2xl font-semibold'>Profile</h1>
        <p className='text-muted text-sm'>
          Borrowers address proposals to your lending key. Anyone can choose any name, so a name is
          not an identity: share your key fingerprint with borrowers so they can compare it.
        </p>
      </header>

      <ProfileSection title='Lending key'>
        <LendingKey name={verifiedName} />
      </ProfileSection>

      <ProfileSection title='Display name'>
        {own === undefined ? (
          <OwnEntryPending ownQuery={ownQuery} />
        ) : (
          <DisplayName own={own} register={register} />
        )}
      </ProfileSection>

      {own !== undefined && (
        <ProfileSection title='Directory'>
          <DirectoryListing own={own} remove={remove} />
        </ProfileSection>
      )}
    </div>
  )
}
