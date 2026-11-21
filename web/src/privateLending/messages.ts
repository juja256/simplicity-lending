// The rules of a private message in the web: how long it may be, and how it is shown.
//
// A message travels in a range proof's 3136 bytes of extra data. At creation it sits inside the
// terms, after their 153 signed bytes and before their 64-byte signature, with its own 4-byte
// header: 3136 − 221 = 2915 bytes of text. The acceptance's, an installment's and the full
// repayment's carry the header and a 64-byte signature: 3136 − 4 − 64 = 3068. The wasm refuses
// longer texts too; the form counts them first, in UTF-8 bytes, so it can say how far over it is.
//
// A message is shown as plain text (`white-space: pre-wrap`), never with a clickable link, after
// `displayMessage` has removed what could break or disguise the row around it.

/** The most UTF-8 bytes of text each channel carries. */
export const MESSAGE_LIMITS = { creation: 2915, signed: 3068 } as const

/** `creation` for the borrower's message in the terms, `signed` for every later one. */
export type MessageChannel = keyof typeof MESSAGE_LIMITS

/** Shown with every message. */
export const MESSAGE_NOTE =
  'A message is not part of the terms, and the contract does not enforce it.'

const encoder = new TextEncoder()

/** The length of `text` in UTF-8 bytes, as the range proof carries it (an emoji is 4). */
export function messageBytes(text: string): number {
  return encoder.encode(text).length
}

/**
 * Why `text` cannot be sent on `channel`, or null if it can. An empty or blank text is no message,
 * not an error.
 */
export function messageError(text: string, channel: MessageChannel): string | null {
  if (text.trim() === '') return null
  const bytes = messageBytes(text)
  const limit = MESSAGE_LIMITS[channel]
  return bytes > limit ? `The message is ${bytes} bytes; at most ${limit} fit.` : null
}

/**
 * The message to send for the text typed: undefined for none (an empty or blank text), otherwise
 * the text exactly as typed, which is what `messageError` counted.
 */
export function messageToSend(text: string | undefined): string | undefined {
  return text === undefined || text.trim() === '' ? undefined : text
}

/**
 * `messageToSend(text)`, for a builder: throws the error `messageError` gives when it does not fit
 * on `channel`.
 */
export function checkedMessage(
  text: string | undefined,
  channel: MessageChannel,
): string | undefined {
  const message = messageToSend(text)
  const error = message === undefined ? null : messageError(message, channel)
  if (error !== null) throw new Error(error)
  return message
}

/**
 * Whether a code point is removed for display: the C0 controls except the newline, DEL, the C1
 * controls, and the bidirectional controls (the Arabic letter mark, the left-to-right and
 * right-to-left marks, the embeddings and overrides, and the isolates). DEL is neither C0 nor C1,
 * but it is a control all the same and shows nothing a sender could mean.
 */
function isRemoved(codePoint: number): boolean {
  return (
    (codePoint <= 0x1f && codePoint !== 0x0a) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  )
}

/** `text` without the characters that could break or disguise its row; newlines are kept. */
export function displayMessage(text: string): string {
  let shown = ''
  for (const char of text) {
    if (!isRemoved(char.codePointAt(0)!)) shown += char
  }
  return shown
}
