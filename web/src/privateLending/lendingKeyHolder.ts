// The lending key of the wallet's current session: derived once per session, freed when the
// session ends. DOM-free, so its rules are checked offline (`pnpm parity`).
//
// A key is let go of in two ways, and they differ on purpose:
// - deriving the key of another session frees the old key, and does nothing else;
// - `endSession` frees the key and then runs `onSessionEnd`, where the app drops what it read or
//   opened with the key.
// Only the provider's session-end paths call `endSession`. The first caller of a session is
// usually a query: if deriving dropped the cache, that query would remove itself mid-fetch.
import type { LendingKey } from '@/wasm/private-lending/private_lending_wasm'

/** The part of the private lending wasm module that derives keys. */
export interface LendingKeyFactory {
  LendingKey: { fromDescriptor(descriptor: string): LendingKey }
}

export interface LendingKeyHolderOptions<S> {
  loadWasm: () => Promise<LendingKeyFactory>
  descriptorOf: (session: S) => string
  /** Whether `session` is still the wallet's session. */
  isCurrent: (session: S) => boolean
  /** Runs once the key of an ended session is released: drop the session's private data. */
  onSessionEnd: () => void
}

export interface LendingKeyHolder<S> {
  /**
   * The key of `session`, which must be the current session. It is derived on first use, and
   * every later call in that session returns the same promise. So a different promise means the
   * session changed. A failed derivation is not kept: the next call tries again.
   */
  get(session: S): Promise<LendingKey>
  /** The session ended: frees its key (a key held past this throws on use), then `onSessionEnd`. */
  endSession(): void
}

export function createLendingKeyHolder<S>(
  options: LendingKeyHolderOptions<S>,
): LendingKeyHolder<S> {
  let held: { session: S; key: Promise<LendingKey> } | null = null

  // Frees the held key, once: a derivation that already resolved is freed here, and one still in
  // flight sees its session is no longer current and never creates a key.
  function release(): void {
    const previous = held
    held = null
    previous?.key.then(
      key => key.free(),
      () => {},
    )
  }

  return {
    get(session) {
      if (held?.session === session) return held.key
      release()
      const key = options.loadWasm().then(wasm => {
        if (!options.isCurrent(session)) throw new Error('The wallet session ended')
        return wasm.LendingKey.fromDescriptor(options.descriptorOf(session))
      })
      const entry = { session, key }
      held = entry
      key.catch(() => {
        if (held === entry) held = null
      })
      return key
    },
    endSession() {
      release()
      options.onSessionEnd()
    },
  }
}
