import { Chip } from '@heroui/react'

import KeyFingerprint from '@/components/KeyFingerprint'
import type { LoanMessage } from '@/privateLending/loanMessages'
import { displayMessage, MESSAGE_NOTE } from '@/privateLending/messages'

/** Who sent a message: a party's key fingerprint and its directory name, verified entries only. */
export interface MessageSender {
  name?: string
  fingerprint: string
  /** The session's own key. */
  isYou?: boolean
}

/** The sender of each party's messages. */
export type MessageSenders = Record<LoanMessage['from'], MessageSender>

/** The step a message came with, in the words both apps use. */
function messagePhaseLabel(message: Pick<LoanMessage, 'phase' | 'installment'>): string {
  switch (message.phase) {
    case 'creation':
      return 'Proposal'
    case 'acceptance':
      return 'Acceptance'
    case 'installment':
      return `Installment ${message.installment}`
    case 'repayment':
      return 'Full repayment'
  }
}

/**
 * One message: its step, its sender's name and key fingerprint, and its text as plain text
 * (`displayMessage`, `white-space: pre-wrap`, never a link), with an "Unverified" badge when its
 * sender did not sign it for this step. An unreadable one says so and shows nothing of it.
 */
export function MessageEntry({ message, sender }: { message: LoanMessage; sender: MessageSender }) {
  return (
    <article className='flex min-w-0 flex-col gap-1.5'>
      <header className='flex flex-wrap items-baseline gap-x-2 gap-y-1'>
        <span className='text-foreground text-sm font-medium'>{messagePhaseLabel(message)}</span>
        <KeyFingerprint fingerprint={sender.fingerprint} name={sender.name} />
        {sender.isYou && <span className='text-muted text-xs'>(you)</span>}
        {message.state === 'unverified' && (
          <Chip color='warning' variant='soft' size='sm'>
            Unverified
          </Chip>
        )}
      </header>
      {message.text === undefined ? (
        <p className='text-muted text-sm italic'>This message could not be read.</p>
      ) : (
        <p className='text-foreground text-sm whitespace-pre-wrap wrap-anywhere'>
          {displayMessage(message.text)}
        </p>
      )}
      {message.state === 'unverified' && (
        <p className='text-muted text-xs'>
          Its sender did not sign it for this step: the other party may have moved it here.
        </p>
      )}
    </article>
  )
}

/**
 * A loan's messages in chain order, each with its sender, then once the note that a message is
 * not part of the terms, and that messages this wallet sent from another browser do not show.
 */
export default function MessageTimeline({
  messages,
  names,
}: {
  messages: readonly LoanMessage[]
  names: MessageSenders
}) {
  return (
    <div className='flex flex-col gap-4'>
      {messages.length === 0 ? (
        <p className='text-muted text-sm'>No messages.</p>
      ) : (
        <ol className='flex flex-col gap-4'>
          {messages.map(message => (
            <li
              key={`${message.phase}:${message.txid}`}
              className='border-separator border-l-2 pl-3'
            >
              <MessageEntry message={message} sender={names[message.from]} />
            </li>
          ))}
        </ol>
      )}
      <div className='text-muted flex flex-col gap-1 text-xs'>
        <p>{MESSAGE_NOTE}</p>
        <p>Messages you sent from another browser do not show here.</p>
      </div>
    </div>
  )
}
