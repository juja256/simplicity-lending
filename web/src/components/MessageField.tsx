import { Description, FieldError, Label, TextArea, TextField } from '@heroui/react'

import {
  MESSAGE_LIMITS,
  messageBytes,
  type MessageChannel,
  messageError,
} from '@/privateLending/messages'

interface MessageFieldProps {
  /** Where the message travels, which sets how many bytes fit. */
  channel: MessageChannel
  value: string
  onChange: (value: string) => void
}

/**
 * The optional private message of a transaction: a text area with its length in UTF-8 bytes
 * against the channel's limit, and `messageError` once it is over. The caller sends the text as
 * typed (`messageToSend`), and nothing while it is empty or blank.
 */
export default function MessageField({ channel, value, onChange }: MessageFieldProps) {
  const error = messageError(value, channel)
  return (
    <TextField value={value} onChange={onChange} isInvalid={error !== null}>
      <Label>Private message (optional)</Label>
      <TextArea rows={3} className='min-h-20' />
      <Description className='tabular-nums'>
        {messageBytes(value)} / {MESSAGE_LIMITS[channel]} bytes
      </Description>
      {error !== null && <FieldError>{error}</FieldError>}
    </TextField>
  )
}
