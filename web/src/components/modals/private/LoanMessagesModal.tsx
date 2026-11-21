import { Spinner } from '@heroui/react'
import { useState } from 'react'

import MessageTimeline, { type MessageSenders } from '@/components/MessageTimeline'
import Notice from '@/components/Notice'
import { UiModal } from '@/components/ui/UiModal'
import { asBorrowerError } from '@/privateLending/borrowerErrors'
import { useDirectory } from '@/privateLending/hooks/useDirectory'
import { useLoanMessages } from '@/privateLending/hooks/useLoanMessages'
import type { OpenedOfferItem } from '@/privateLending/offerView'
import { ErrorHandler } from '@/utils/errorHandler'

/** Both parties of `item`, by their directory names (verified entries only) and fingerprints. */
function useSenders(item: OpenedOfferItem): MessageSenders {
  const { lookup } = useDirectory()
  const { terms, role } = item
  return {
    borrower: {
      name: lookup(terms.borrowerPublicKey)?.display_name,
      fingerprint: terms.borrowerFingerprint,
      isYou: role === 'borrower',
    },
    lender: {
      name: lookup(terms.lenderPublicKey)?.display_name,
      fingerprint: terms.lenderFingerprint,
      isYou: role === 'lender',
    },
  }
}

interface LoanMessagesModalProps {
  isOpen: boolean
  item: OpenedOfferItem
  onClose: () => void
}

/** The private messages of a loan, in chain order (`useLoanMessages`), for either party. */
export default function LoanMessagesModal({ isOpen, item, onClose }: LoanMessagesModalProps) {
  const { messages, isLoading, error } = useLoanMessages(item)
  const names = useSenders(item)
  return (
    <UiModal
      isOpen={isOpen}
      onOpenChange={open => {
        if (!open) onClose()
      }}
      title='Messages'
    >
      <div className='flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1'>
        {error !== undefined && (
          <Notice role='alert'>
            The loan&apos;s later messages could not be read; the app tries again every 30 seconds:{' '}
            {ErrorHandler.describe(item.role === 'borrower' ? asBorrowerError(error) : error)}
          </Notice>
        )}
        {isLoading && (
          <p role='status' className='text-muted flex items-center gap-2 text-sm'>
            <Spinner size='sm' color='current' className='size-3' aria-hidden />
            Reading the messages…
          </p>
        )}
        <MessageTimeline messages={messages} names={names} />
      </div>
    </UiModal>
  )
}

/**
 * "Messages (n)", which opens the loan's messages; nothing while it has none. A secondary link
 * beside a row's one action.
 */
export function MessagesLink({ item }: { item: OpenedOfferItem }) {
  const { messages } = useLoanMessages(item)
  const [isOpen, setIsOpen] = useState(false)
  if (messages.length === 0 && !isOpen) return null
  return (
    <>
      <button
        type='button'
        className='text-accent cursor-pointer self-start text-sm hover:underline'
        onClick={() => setIsOpen(true)}
      >
        Messages ({messages.length})
      </button>
      <LoanMessagesModal isOpen={isOpen} item={item} onClose={() => setIsOpen(false)} />
    </>
  )
}
