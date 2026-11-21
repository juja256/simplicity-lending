import { describe, expect, it, vi } from 'vitest'

import { PrivateBroadcastError, sendSaved } from './sendSaved'

const TXID = 'ab'.repeat(32)

describe('sendSaved', () => {
  it('keeps the saved transaction when the check before broadcast fails', async () => {
    const broadcast = vi.fn(async () => {})
    const check = async () => {
      throw new Error('The term has passed.')
    }

    const sent = sendSaved(TXID, check, broadcast)

    await expect(sent).rejects.toBeInstanceOf(PrivateBroadcastError)
    await expect(sent).rejects.toMatchObject({ txid: TXID, message: 'The term has passed.' })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('broadcasts once when the check passes', async () => {
    const broadcast = vi.fn(async () => {})

    await sendSaved(TXID, async () => {}, broadcast)

    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('broadcasts once when there is no check', async () => {
    const broadcast = vi.fn(async () => {})

    await sendSaved(TXID, undefined, broadcast)

    expect(broadcast).toHaveBeenCalledTimes(1)
  })
})
