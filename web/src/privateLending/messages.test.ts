import { describe, expect, it } from 'vitest'

import { wasm } from '@/test/wasm'

import {
  checkedMessage,
  displayMessage,
  MESSAGE_LIMITS,
  messageBytes,
  messageError,
  messageToSend,
  shownMessage,
} from './messages'

const borrower = wasm.LendingKey.fromMasterBlindingKey('01'.repeat(32))
const lender = wasm.LendingKey.fromMasterBlindingKey('02'.repeat(32))
const CREATION_TXID = 'ab'.repeat(32)

/** The error a wasm call throws, as text. */
function thrown(call: () => unknown): string {
  try {
    call()
  } catch (error) {
    return String(error)
  }
  throw new Error('the call did not throw')
}

describe('messageBytes', () => {
  it('counts UTF-8 bytes, not characters', () => {
    expect(messageBytes('a')).toBe(1)
    expect(messageBytes('€')).toBe(3)
    expect(messageBytes('😀')).toBe(4)
    expect(messageBytes('Привіт')).toBe(12)
    expect(messageBytes('')).toBe(0)
  })
})

describe('messageError', () => {
  it('is none for an empty or blank text, which is no message', () => {
    expect(messageError('', 'signed')).toBeNull()
    expect(messageError(' \n\t ', 'creation')).toBeNull()
  })

  it('refuses one byte over each limit, naming both counts', () => {
    expect(messageError('a'.repeat(2915), 'creation')).toBeNull()
    expect(messageError('a'.repeat(2916), 'creation')).toBe(
      'The message is 2916 bytes; at most 2915 fit.',
    )
    expect(messageError('a'.repeat(3068), 'signed')).toBeNull()
    expect(messageError('a'.repeat(3069), 'signed')).toBe(
      'The message is 3069 bytes; at most 3068 fit.',
    )
  })

  it('counts an emoji as 4 bytes at the limit', () => {
    const atLimit = '😀'.repeat(767)
    expect(atLimit.length).toBe(1534)
    expect(messageError(atLimit, 'signed')).toBeNull()
    expect(messageError(`${atLimit}a`, 'signed')).toBe(
      'The message is 3069 bytes; at most 3068 fit.',
    )
  })
})

describe('messageError on text that is not well-formed', () => {
  // A lone surrogate would reach the wasm as U+FFFD, so the text read back would not be the text
  // sent (the installment's read-back, the creation's self-check).
  it('refuses a lone surrogate on either channel, before counting bytes', () => {
    const broken = 'The 😀 is cut: \uD83D'
    for (const channel of ['creation', 'signed'] as const) {
      expect(messageError(broken, channel)).toBe(
        'The message has a broken character, such as half an emoji: delete it and type it again.',
      )
      expect(messageError('\uDE00 alone', channel)).not.toBeNull()
      expect(messageError(`${'a'.repeat(4000)}\uD83D`, channel)).toContain('broken character')
      expect(() => checkedMessage(broken, channel)).toThrow('broken character')
    }
  })

  it('takes a whole emoji, Cyrillic and the like', () => {
    expect(messageError('Привіт 😀 👍🏽 🇺🇦', 'signed')).toBeNull()
  })
})

describe('messageToSend', () => {
  it('sends no message for none, an empty or a blank text, and any other exactly as typed', () => {
    for (const none of [undefined, '', ' \n\t ']) expect(messageToSend(none)).toBeUndefined()
    expect(messageToSend(' two\nlines ')).toBe(' two\nlines ')
  })

  it("throws the counter's error for a builder, and gives the text otherwise", () => {
    expect(checkedMessage('  ', 'signed')).toBeUndefined()
    expect(checkedMessage('a'.repeat(2915), 'creation')).toBe('a'.repeat(2915))
    expect(() => checkedMessage('a'.repeat(2916), 'creation')).toThrow(
      'The message is 2916 bytes; at most 2915 fit.',
    )
  })
})

describe('MESSAGE_LIMITS', () => {
  it('matches the wasm: a signed message at the limit signs, one byte over is refused', () => {
    const limit = MESSAGE_LIMITS.signed
    for (const [phase, installment] of [
      [wasm.MessagePhase.Acceptance, 0],
      [wasm.MessagePhase.Installment, 1],
      [wasm.MessagePhase.FullRepayment, 0],
    ] as const) {
      wasm.signMessage(borrower, CREATION_TXID, phase, installment, 'a'.repeat(limit)).free()
      const error = thrown(() =>
        wasm.signMessage(borrower, CREATION_TXID, phase, installment, 'a'.repeat(limit + 1)),
      )
      expect(error).toMatch(/^bad-input:/)
      expect(error).toContain(String(limit + 1))
      expect(error).toContain(String(limit))
    }
  })

  it('matches the wasm: a creation message at the limit builds, one byte over is refused', () => {
    const limit = MESSAGE_LIMITS.creation
    const build = (message: string) => {
      const terms = new wasm.OfferTermsInput(
        'aa'.repeat(32),
        1000n,
        1100n,
        1000,
        500,
        '11'.repeat(32),
        '22'.repeat(32),
      )
      return wasm.NewOffer.build(
        borrower,
        lender.xOnlyPublicKey(),
        `${'cd'.repeat(32)}:0`,
        'bb'.repeat(32),
        2000n,
        terms,
        message,
      )
    }
    build('a'.repeat(limit)).free()
    const error = thrown(() => build('a'.repeat(limit + 1)))
    expect(error).toMatch(/^bad-input:/)
    expect(error).toContain(String(limit + 1))
    expect(error).toContain(String(limit))
  })
})

describe('displayMessage', () => {
  it('removes the bidirectional controls', () => {
    // as code points: written as characters, they would hide in the source
    const bidi = [
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
      0x2069,
    ]
    for (const codePoint of bidi) {
      expect(displayMessage(`a${String.fromCodePoint(codePoint)}b`)).toBe('ab')
    }
  })

  it('removes the C0 and C1 controls and DEL, but keeps the newline', () => {
    for (const control of ['\u0000', '\u0009', '\u000D', '\u001B', '\u001F']) {
      expect(displayMessage(`a${control}b`)).toBe('ab')
    }
    for (const control of ['\u007F', '\u0080', '\u0085', '\u009F']) {
      expect(displayMessage(`a${control}b`)).toBe('ab')
    }
    expect(displayMessage('line one\r\nline two')).toBe('line one\nline two')
  })

  it('keeps everything else, Cyrillic and emoji included', () => {
    const [nbsp, zwj] = [String.fromCodePoint(0xa0), String.fromCodePoint(0x200d)]
    const text = `Привіт, світе!\n${nbsp}Pay 5 € by Friday 😀 ${zwj}`
    expect(displayMessage(text)).toBe(text)
    const [rlo, pdf] = [String.fromCodePoint(0x202e), String.fromCodePoint(0x202c)]
    expect(displayMessage(`pay ${rlo}ecnetnes${pdf} now\u0000`)).toBe('pay ecnetnes now')
  })
})

describe('shownMessage', () => {
  it('is the text as displayed', () => {
    expect(shownMessage('pay\u0000 now\nplease')).toBe('pay now\nplease')
  })

  it('is undefined when nothing visible is left: blank, or only removed characters', () => {
    const rlo = String.fromCodePoint(0x202e)
    for (const text of ['\n'.repeat(500), ' \t ', `${rlo}\u0000\n\u007F`]) {
      expect(shownMessage(text)).toBeUndefined()
    }
  })
})
