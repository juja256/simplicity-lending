import { useQueries } from '@tanstack/react-query'
import {
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'

import { fetchTxConfirmations } from '@/api/esplora/methods'
import { useLatestRef } from '@/hooks/useLatestRef'
import { keepsDiscardTrace } from '@/privateLending/repayPlan'
import { useWallet } from '@/providers/wallet/useWallet'

import { PendingTransactionsContext } from './PendingTransactionsContext'
import { deletePrivateTx, getPrivateTx, loadPrivateTxsForWallet, putPrivateTx } from './storage'
import type { PrivateTxRecord, SavePrivateTxInput } from './types'

const CONFIRMATION_POLL_MS = 15_000
const CONFIRMED_THRESHOLD = 1
const FINALIZED_THRESHOLD = 2
/** Defensive cap on how long a pending record can sit untracked before we give up on it. */
const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000
const FINALIZED_CLEANUP_GRACE_MS = 10 * 60 * 1000
const SWEEP_INTERVAL_MS = 15_000

type TrackedTxStatus = 'processing' | 'confirmed' | 'finalized'

interface TxStatusSnapshot {
  status: TrackedTxStatus
  confirmations: number | null
}

/** What confirmation tracking reads and writes. */
type TrackedRecord = Pick<
  PrivateTxRecord,
  'txid' | 'confirmationStatus' | 'confirmations' | 'finalizedAt'
>

/** What the sweep reads. */
type SweptRecord = TrackedRecord & Pick<PrivateTxRecord, 'createdAt'>

/** The patch of a record the sweep gives up on. */
const TRACKING_TIMED_OUT = {
  confirmationStatus: 'failed',
  errorMessage: 'Transaction tracking timed out.',
} as const satisfies Partial<PrivateTxRecord>

/**
 * What the sweep does with a record: give up on one still not finalized after
 * `MAX_PENDING_AGE_MS` (`fail`), forget a finalized one after `FINALIZED_CLEANUP_GRACE_MS`
 * (`remove`), or nothing.
 */
function sweepAction(record: SweptRecord, now: number): 'fail' | 'remove' | null {
  if (record.confirmationStatus === 'failed') return null
  if (record.confirmationStatus !== 'finalized' && now - record.createdAt > MAX_PENDING_AGE_MS) {
    return 'fail'
  }
  if (
    record.confirmationStatus === 'finalized' &&
    record.finalizedAt &&
    now - record.finalizedAt > FINALIZED_CLEANUP_GRACE_MS
  ) {
    return 'remove'
  }
  return null
}

function usePendingTxConfirmationTracking(
  records: TrackedRecord[],
  onUpdate: (txid: string, patch: Partial<TrackedRecord>) => void,
) {
  const recordsRef = useLatestRef(records)
  const onUpdateRef = useLatestRef(onUpdate)
  const snapshots = useQueries({
    queries: records.map(record => ({
      queryKey: ['tx-status', record.txid],
      enabled: record.confirmationStatus !== 'finalized',
      refetchInterval: CONFIRMATION_POLL_MS,
      queryFn: async ({ signal }) => {
        const confirmations = await fetchTxConfirmations(record.txid, { signal })
        if (confirmations === null) {
          return { status: 'processing', confirmations } satisfies TxStatusSnapshot
        }

        const status: TrackedTxStatus =
          confirmations >= FINALIZED_THRESHOLD
            ? 'finalized'
            : confirmations >= CONFIRMED_THRESHOLD
              ? 'confirmed'
              : 'processing'

        return { status, confirmations } satisfies TxStatusSnapshot
      },
    })),
    combine: results => results.map(result => result.data ?? null),
  })

  useEffect(() => {
    snapshots.forEach((snapshot, index) => {
      const record = recordsRef.current[index]
      if (!record || !snapshot) return
      if (
        snapshot.status === record.confirmationStatus &&
        snapshot.confirmations === record.confirmations
      ) {
        return
      }

      // `TxStatus` ('processing' | 'confirmed' | 'finalized') is a subset of
      // `PendingTxConfirmationStatus`, so it can be stored directly with no mapping.
      const patch: Partial<TrackedRecord> = {
        confirmationStatus: snapshot.status,
        confirmations: snapshot.confirmations,
      }
      if (snapshot.status === 'finalized' && !record.finalizedAt) {
        patch.finalizedAt = Date.now()
      }
      onUpdateRef.current(record.txid, patch)
    })
  }, [onUpdateRef, recordsRef, snapshots])
}

/**
 * The wallet's private lending transactions: saved finalized before their first broadcast,
 * tracked to finality, then forgotten. A discarded installment stays, untracked, as its discard's
 * trace (`discardedTxs`). Disabled for wallets that cannot run private loans: then it opens no
 * database and runs no timer.
 */
function usePrivateTxStore(scriptPubkey: string | null, enabled: boolean) {
  const [records, setRecords] = useState<PrivateTxRecord[]>([])
  const privateTxs = useMemo(
    () => records.filter(record => record.discardedAt === undefined),
    [records],
  )
  const discardedTxs = useMemo(
    () => records.filter(record => record.discardedAt !== undefined),
    [records],
  )
  const privateTxsRef = useLatestRef(privateTxs)

  useEffect(() => {
    if (!scriptPubkey || !enabled) return
    let cancelled = false
    loadPrivateTxsForWallet(scriptPubkey)
      .catch(error => {
        console.warn('[PendingTransactions] Failed to load private transactions', error)
        return []
      })
      .then(records => {
        if (cancelled) return
        // A record saved while loading is newer than its stored copy.
        setRecords(prev => [
          ...prev,
          ...records.filter(record => !prev.some(saved => saved.txid === record.txid)),
        ])
      })
    return () => {
      cancelled = true
    }
  }, [scriptPubkey, enabled])

  const savePrivateTx = useCallback(
    async (input: SavePrivateTxInput) => {
      if (!scriptPubkey) throw new Error('No wallet is connected')
      if (!enabled) throw new Error('Private loans need Jade or the seed wallet')
      const now = Date.now()
      const record: PrivateTxRecord = {
        ...input,
        walletScriptPubkey: scriptPubkey,
        broadcastStatus: 'built',
        confirmationStatus: 'processing',
        confirmations: null,
        createdAt: now,
        updatedAt: now,
      }
      // A failed write rejects: the caller must not broadcast then.
      await putPrivateTx(record)
      setRecords(prev => [...prev.filter(saved => saved.txid !== record.txid), record])
    },
    [scriptPubkey, enabled],
  )

  const updatePrivateTx = useCallback(
    async (txid: string, patch: Partial<PrivateTxRecord>) => {
      if (!enabled) return
      const updatedAt = Date.now()
      setRecords(prev =>
        prev.map(record => (record.txid === txid ? { ...record, ...patch, updatedAt } : record)),
      )
      try {
        // A record saved by this wallet's previous store instance may not be in state.
        const current =
          privateTxsRef.current.find(record => record.txid === txid) ?? (await getPrivateTx(txid))
        if (current) await putPrivateTx({ ...current, ...patch, updatedAt })
      } catch (error) {
        console.warn('[PendingTransactions] Failed to persist private transaction', error)
      }
    },
    [enabled, privateTxsRef],
  )

  const removePrivateTx = useCallback(
    async (txid: string) => {
      if (!enabled) return
      setRecords(prev => prev.filter(record => record.txid !== txid))
      try {
        await deletePrivateTx(txid)
      } catch (error) {
        console.warn('[PendingTransactions] Failed to delete private transaction', error)
      }
    },
    [enabled],
  )

  const discardPrivateTx = useCallback(
    async (txid: string) => {
      if (!enabled) return
      const record =
        privateTxsRef.current.find(saved => saved.txid === txid) ?? (await getPrivateTx(txid))
      if (record === undefined || !keepsDiscardTrace(record)) return removePrivateTx(txid)
      // The trace must persist, or a rebuild after a reload could reuse the installment's key: a
      // failed write rejects, and the record stays as it was.
      const discarded: PrivateTxRecord = { ...record, discardedAt: Date.now() }
      await putPrivateTx(discarded)
      setRecords(prev => prev.map(saved => (saved.txid === txid ? discarded : saved)))
    },
    [enabled, privateTxsRef, removePrivateTx],
  )

  const trackedPrivateTxs = useMemo(
    () => privateTxs.filter(record => record.confirmationStatus !== 'failed'),
    [privateTxs],
  )
  const onPrivateTxStatus = useCallback(
    (txid: string, patch: Partial<TrackedRecord>) => {
      // A transaction seen in a block was broadcast, by whichever attempt.
      const seen = patch.confirmations !== null && patch.confirmations !== undefined
      void updatePrivateTx(txid, seen ? { ...patch, broadcastStatus: 'broadcast' } : patch)
    },
    [updatePrivateTx],
  )
  usePendingTxConfirmationTracking(trackedPrivateTxs, onPrivateTxStatus)

  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => {
      const now = Date.now()
      for (const record of privateTxsRef.current) {
        const action = sweepAction(record, now)
        if (action === 'fail') void updatePrivateTx(record.txid, TRACKING_TIMED_OUT)
        else if (action === 'remove') void removePrivateTx(record.txid)
      }
    }, SWEEP_INTERVAL_MS)
    return () => clearInterval(id)
  }, [enabled, privateTxsRef, updatePrivateTx, removePrivateTx])

  return {
    privateTxs,
    discardedTxs,
    savePrivateTx,
    updatePrivateTx,
    removePrivateTx,
    discardPrivateTx,
  }
}

/**
 * Owns the private transactions of one wallet. Remounted (via `key`) whenever the connected
 * wallet changes, so state resets to a clean slate without ever calling setState synchronously
 * from within an effect just to clear stale data for the previous wallet.
 */
function PendingTransactionsStore({
  scriptPubkey,
  privateCapable,
  children,
}: {
  scriptPubkey: string | null
  privateCapable: boolean
  children: ReactNode
}) {
  const store = usePrivateTxStore(scriptPubkey, privateCapable)
  const { privateTxs, discardedTxs, savePrivateTx, updatePrivateTx } = store
  const { removePrivateTx, discardPrivateTx } = store

  const contextValue = useMemo(
    () => ({
      privateTxs,
      discardedTxs,
      savePrivateTx,
      updatePrivateTx,
      removePrivateTx,
      discardPrivateTx,
    }),
    [privateTxs, discardedTxs, savePrivateTx, updatePrivateTx, removePrivateTx, discardPrivateTx],
  )

  return (
    <PendingTransactionsContext.Provider value={contextValue}>
      {children}
    </PendingTransactionsContext.Provider>
  )
}

export function PendingTransactionsProvider({ children }: PropsWithChildren) {
  const { scriptPubkey, privateCapable } = useWallet()

  return (
    <PendingTransactionsStore
      key={scriptPubkey ?? 'disconnected'}
      scriptPubkey={scriptPubkey}
      privateCapable={privateCapable}
    >
      {children}
    </PendingTransactionsStore>
  )
}
