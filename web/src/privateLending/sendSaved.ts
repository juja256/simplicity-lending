// The last step of a private lending transaction, once it is finalized and saved: the check before
// broadcast, then the broadcast. Pure of React, so tests import it.
import { ErrorHandler } from '@/utils/errorHandler'

/**
 * The saved transaction was not broadcast: its broadcast failed, or the check before it did. The
 * transaction stays saved: offer `retryBroadcast(txid)`, never a rebuild.
 */
export class PrivateBroadcastError extends Error {
  readonly txid: string

  constructor(txid: string, cause: unknown) {
    super(ErrorHandler.describe(cause), { cause })
    this.name = 'PrivateBroadcastError'
    this.txid = txid
  }
}

/**
 * Sends the saved transaction `txid`: `broadcast` runs only once `beforeBroadcast` (if given)
 * resolved. A failing check, such as a stale term or a tip that could not be fetched, throws a
 * `PrivateBroadcastError` with the check's message, so the caller offers the saved transaction
 * again (or only to discard it), never a second build.
 */
export async function sendSaved(
  txid: string,
  beforeBroadcast: (() => Promise<void>) | undefined,
  broadcast: () => Promise<void>,
): Promise<void> {
  try {
    await beforeBroadcast?.()
  } catch (error) {
    throw new PrivateBroadcastError(txid, error)
  }
  await broadcast()
}
