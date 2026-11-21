// Why a query that has no data failed, kept while it is fetched again. React Query v5 puts an
// errored query without data back to `pending` for each refetch, with its `error` and its
// `failureReason` both null until that attempt fails: a notice that read them would give way to
// "Reading…" on every retry (every 30 seconds for a loan), then come back.
import { useState } from 'react'

/** What `keptReadError` reads of a query's result. */
interface ReadResult {
  data: unknown
  error: Error | null
  failureReason: Error | null
}

/**
 * The error to show for `result`: none once it has data; else its error, or the failure of an
 * attempt before its retry, or else `kept`, the one shown before.
 */
export function keptReadError(kept: Error | undefined, result: ReadResult): Error | undefined {
  if (result.data !== undefined) return undefined
  return result.error ?? result.failureReason ?? kept
}

/** `keptReadError` of `result` across renders: why the read failed, until it succeeds. */
export function useReadError(result: ReadResult): Error | undefined {
  const [kept, setKept] = useState<Error | undefined>(undefined)
  const shown = keptReadError(kept, result)
  // Adjusting state while rendering, as React documents for state derived from props.
  if (shown !== kept) setKept(shown)
  return shown
}
