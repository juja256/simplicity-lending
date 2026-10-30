import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { fetchTxConfirmations } from '@/api/esplora/methods'
import { invalidateAllIndexerQueries } from '@/api/indexer/invalidateIndexerQueries'
import { fetchBorrowerOffers, fetchFactoriesByScript, fetchOffer } from '@/api/indexer/methods'
import { borrowerQueryKeys, factoryQueryKeys, offersQueryKeys } from '@/api/indexer/queryKeys'
import { useLatestRef } from '@/hooks/useLatestRef'
import { usePendingTxToasts } from '@/hooks/usePendingTxToasts'
import { useWallet } from '@/providers/wallet/useWallet'

import { PendingTransactionsContext } from './PendingTransactionsContext'
import {
  deletePendingTx,
  deletePrivateTx,
  getPrivateTx,
  loadPendingTxsForWallet,
  loadPrivateTxsForWallet,
  putPendingTx,
  putPrivateTx,
} from './storage'
import type {
  AddPendingTxInput,
  PendingTxRecord,
  PrivateTxRecord,
  SavePrivateTxInput,
} from './types'

const CONFIRMATION_POLL_MS = 15_000
const CONFIRMED_THRESHOLD = 1
const FINALIZED_THRESHOLD = 2
/** Defensive cap on how long a pending record can sit untracked before we give up on it. */
const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000
const FINALIZED_CLEANUP_GRACE_MS = 10 * 60 * 1000
const SWEEP_INTERVAL_MS = 15_000
const CREATED_OFFER_HIGHLIGHT_MS = 8_000

type OfferRecordGroup = [offerId: string, records: PendingTxRecord[]]
type TrackedTxStatus = 'processing' | 'confirmed' | 'finalized'

interface TxStatusSnapshot {
  status: TrackedTxStatus
  confirmations: number | null
}

/** What confirmation tracking reads and writes: common to public and private records. */
type TrackedRecord = Pick<
  PendingTxRecord,
  'txid' | 'confirmationStatus' | 'confirmations' | 'finalizedAt'
>

/** What the sweep reads: common to public and private records. */
type SweptRecord = TrackedRecord & Pick<PendingTxRecord, 'createdAt'>

/** The patch of a record the sweep gives up on. */
const TRACKING_TIMED_OUT = {
  confirmationStatus: 'failed',
  errorMessage: 'Transaction tracking timed out.',
} as const satisfies Partial<PendingTxRecord>

/**
 * What the sweep does with a record: give up on one still not finalized after
 * `MAX_PENDING_AGE_MS` (`fail`), forget a finalized one after `FINALIZED_CLEANUP_GRACE_MS`
 * (`remove`), or nothing. One rule for public and private records, so the two cannot drift.
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

function useOfferCleanupPolling({
  offerGroups,
  onRemove,
  onChecked,
}: {
  offerGroups: OfferRecordGroup[]
  onRemove: (txid: string) => void
  onChecked: (txid: string) => void
}) {
  const offerGroupsRef = useLatestRef(offerGroups)
  const onRemoveRef = useLatestRef(onRemove)
  const onCheckedRef = useLatestRef(onChecked)
  const processedAtRef = useRef(new Map<string, number>())
  const results = useQueries({
    queries: offerGroups.map(([offerId]) => ({
      queryKey: offersQueryKeys.detail(offerId),
      queryFn: ({ signal }) => fetchOffer(offerId, { signal }),
    })),
    combine: queryResults =>
      queryResults.map(result => ({
        data: result.data,
        dataUpdatedAt: result.dataUpdatedAt,
        isSuccess: result.isSuccess,
      })),
  })

  useEffect(() => {
    results.forEach((result, index) => {
      const group = offerGroupsRef.current[index]
      if (!group || !result.isSuccess || !result.data) return

      const [offerId, records] = group
      if (processedAtRef.current.get(offerId) === result.dataUpdatedAt) return
      processedAtRef.current.set(offerId, result.dataUpdatedAt)

      for (const record of records) {
        const isCleaned =
          record.kind === 'claim_principal'
            ? !result.data.borrower_principal_utxo && record.confirmationStatus !== 'processing'
            : record.expectedOfferStatus !== undefined &&
              result.data.status === record.expectedOfferStatus

        if (isCleaned) {
          onRemoveRef.current(record.txid)
        } else {
          onCheckedRef.current(record.txid)
        }
      }
    })
  }, [offerGroupsRef, onCheckedRef, onRemoveRef, results])

  useEffect(() => {
    const offerIds = new Set(offerGroups.map(([offerId]) => offerId))
    for (const offerId of processedAtRef.current.keys()) {
      if (!offerIds.has(offerId)) processedAtRef.current.delete(offerId)
    }
  }, [offerGroups])
}

function useCreateOfferCleanupPolling({
  scriptPubkey,
  records,
  onCreated,
  onChecked,
}: {
  scriptPubkey: string | null
  records: PendingTxRecord[]
  onCreated: (txid: string, offerId: string) => void
  onChecked: (txid: string) => void
}) {
  const recordsRef = useLatestRef(records)
  const onCreatedRef = useLatestRef(onCreated)
  const onCheckedRef = useLatestRef(onChecked)
  const processedAtRef = useRef<number | null>(null)
  const { data, dataUpdatedAt, isSuccess } = useQuery({
    queryKey: borrowerQueryKeys.offers(scriptPubkey ?? '', {}),
    queryFn: ({ signal }) => fetchBorrowerOffers(scriptPubkey as string, {}, { signal }),
    enabled: Boolean(scriptPubkey && records.length > 0),
    select: response => response.items,
  })

  useEffect(() => {
    if (processedAtRef.current === dataUpdatedAt) return
    if (!isSuccess || !data) return
    processedAtRef.current = dataUpdatedAt

    for (const record of recordsRef.current) {
      const matched = data.find(offer => offer.created_at_txid === record.txid)
      if (matched) {
        onCreatedRef.current(record.txid, matched.id)
      } else {
        onCheckedRef.current(record.txid)
      }
    }
  }, [data, dataUpdatedAt, isSuccess, onCheckedRef, onCreatedRef, recordsRef])
}

function useCreateBorrowerAccountCleanupPolling({
  scriptPubkey,
  records,
  onRemove,
  onChecked,
}: {
  scriptPubkey: string | null
  records: PendingTxRecord[]
  onRemove: (txid: string) => void
  onChecked: (txid: string) => void
}) {
  const recordsRef = useLatestRef(records)
  const onRemoveRef = useLatestRef(onRemove)
  const onCheckedRef = useLatestRef(onChecked)
  const processedAtRef = useRef<number | null>(null)
  const { data, dataUpdatedAt, isSuccess } = useQuery({
    queryKey: factoryQueryKeys.byScript(scriptPubkey ?? ''),
    queryFn: ({ signal }) => fetchFactoriesByScript(scriptPubkey as string, { signal }),
    enabled: Boolean(scriptPubkey && records.length > 0),
  })

  useEffect(() => {
    if (processedAtRef.current === dataUpdatedAt) return
    if (!isSuccess || !data) return
    processedAtRef.current = dataUpdatedAt

    for (const record of recordsRef.current) {
      const matched = data.find(factory => factory.created_at_txid === record.txid)
      if (matched) {
        onRemoveRef.current(record.txid)
      } else {
        onCheckedRef.current(record.txid)
      }
    }
  }, [data, dataUpdatedAt, isSuccess, onCheckedRef, onRemoveRef, recordsRef])
}

/**
 * The wallet's private lending transactions: saved finalized before their first broadcast,
 * tracked to finality like public ones, then forgotten. Separate from the public records, so
 * public pages (blocking banners, toasts, the bell) never see them. Disabled for wallets that
 * cannot run private loans: then it opens no database and runs no timer.
 */
function usePrivateTxStore(scriptPubkey: string | null, enabled: boolean) {
  const [privateTxs, setPrivateTxs] = useState<PrivateTxRecord[]>([])
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
        setPrivateTxs(prev => [
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
      // Unlike public records, a failed write rejects: the caller must not broadcast then.
      await putPrivateTx(record)
      setPrivateTxs(prev => [...prev.filter(saved => saved.txid !== record.txid), record])
    },
    [scriptPubkey, enabled],
  )

  const updatePrivateTx = useCallback(
    async (txid: string, patch: Partial<PrivateTxRecord>) => {
      if (!enabled) return
      const updatedAt = Date.now()
      setPrivateTxs(prev =>
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
      setPrivateTxs(prev => prev.filter(record => record.txid !== txid))
      try {
        await deletePrivateTx(txid)
      } catch (error) {
        console.warn('[PendingTransactions] Failed to delete private transaction', error)
      }
    },
    [enabled],
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

  return { privateTxs, savePrivateTx, updatePrivateTx, removePrivateTx }
}

/**
 * Owns pending-tx state for one wallet. Remounted (via `key`) whenever the connected wallet
 * changes, so state resets to a clean slate without ever calling setState synchronously from
 * within an effect just to clear stale data for the previous wallet.
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
  const queryClient = useQueryClient()
  const [pendingTxs, setPendingTxs] = useState<PendingTxRecord[]>([])
  const [isLoading, setIsLoading] = useState(Boolean(scriptPubkey))
  const [surfacedTxids, setSurfacedTxids] = useState<Set<string>>(new Set())
  const [newlyCreatedOfferIds, setNewlyCreatedOfferIds] = useState<Set<string>>(new Set())
  const [highlightedCreatedOfferIds, setHighlightedCreatedOfferIds] = useState<Set<string>>(
    new Set(),
  )
  const createdOfferHighlightTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const timers = createdOfferHighlightTimersRef.current

    return () => {
      timers.forEach(timer => clearTimeout(timer))
      timers.clear()
    }
  }, [])

  useEffect(() => {
    if (!scriptPubkey) return
    let cancelled = false
    loadPendingTxsForWallet(scriptPubkey)
      .catch(error => {
        console.warn('[PendingTransactions] Failed to load pending transactions', error)
        return []
      })
      .then(records => {
        if (!cancelled) {
          setPendingTxs(records)
          setIsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [scriptPubkey])

  const invalidateIndexerQueries = useCallback(() => {
    invalidateAllIndexerQueries(queryClient)
  }, [queryClient])

  const addPendingTx = useCallback(
    async (input: AddPendingTxInput) => {
      const now = Date.now()
      const record: PendingTxRecord = {
        ...input,
        confirmationStatus: 'processing',
        confirmations: null,
        createdAt: now,
        updatedAt: now,
      }
      setPendingTxs(prev => [...prev, record])
      invalidateIndexerQueries()
      try {
        await putPendingTx(record)
      } catch (error) {
        console.warn('[PendingTransactions] Failed to persist pending transaction', error)
      }
    },
    [invalidateIndexerQueries],
  )

  const updatePendingTx = useCallback(async (txid: string, patch: Partial<PendingTxRecord>) => {
    setPendingTxs(prev => {
      const next = prev.map(record =>
        record.txid === txid ? { ...record, ...patch, updatedAt: Date.now() } : record,
      )
      const updated = next.find(record => record.txid === txid)
      if (updated) {
        void putPendingTx(updated).catch(error => {
          console.warn('[PendingTransactions] Failed to persist pending transaction', error)
        })
      }
      return next
    })
  }, [])

  const removePendingTx = useCallback(
    async (txid: string) => {
      setPendingTxs(prev => prev.filter(record => record.txid !== txid))
      // The record is only removed once a cleanup watcher confirms the indexer caught up — that's
      // exactly when other pages' stale list/detail caches need to be told to refetch too.
      invalidateIndexerQueries()
      try {
        await deletePendingTx(txid)
      } catch (error) {
        console.warn('[PendingTransactions] Failed to delete pending transaction', error)
      }
    },
    [invalidateIndexerQueries],
  )

  const markChecked = useCallback(
    (txid: string) => {
      void updatePendingTx(txid, { lastIndexerCheckAt: Date.now() })
    },
    [updatePendingTx],
  )

  const removeByTxid = useCallback(
    (txid: string) => {
      void removePendingTx(txid)
    },
    [removePendingTx],
  )

  const handleCreatedOffer = useCallback(
    (txid: string, offerId: string) => {
      setNewlyCreatedOfferIds(prev => {
        if (prev.has(offerId)) return prev
        const next = new Set(prev)
        next.add(offerId)
        return next
      })
      removeByTxid(txid)
    },
    [removeByTxid],
  )

  const startCreatedOfferHighlight = useCallback((offerId: string) => {
    if (createdOfferHighlightTimersRef.current.has(offerId)) return

    setNewlyCreatedOfferIds(prev => {
      const next = new Set(prev)
      next.delete(offerId)
      return next
    })
    setHighlightedCreatedOfferIds(prev => new Set(prev).add(offerId))

    const timer = setTimeout(() => {
      createdOfferHighlightTimersRef.current.delete(offerId)
      setHighlightedCreatedOfferIds(prev => {
        const next = new Set(prev)
        next.delete(offerId)
        return next
      })
    }, CREATED_OFFER_HIGHLIGHT_MS)
    createdOfferHighlightTimersRef.current.set(offerId, timer)
  }, [])

  const addSurfaceToast = useCallback((txid: string) => {
    setSurfacedTxids(prev => (prev.has(txid) ? prev : new Set(prev).add(txid)))
  }, [])

  // If indexer-based cleanup never catches up, fall back to trusting on-chain finality.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now()
      for (const record of pendingTxs) {
        const action = sweepAction(record, now)
        if (action === 'fail') void updatePendingTx(record.txid, TRACKING_TIMED_OUT)
        else if (action === 'remove') removeByTxid(record.txid)
      }
    }, SWEEP_INTERVAL_MS)
    return () => clearInterval(id)
  }, [pendingTxs, updatePendingTx, removeByTxid])

  const activeRecords = useMemo(
    () => pendingTxs.filter(record => record.confirmationStatus !== 'failed'),
    [pendingTxs],
  )

  const offerIdGroups = useMemo(() => {
    const groups = new Map<string, PendingTxRecord[]>()
    for (const record of activeRecords) {
      if (!record.offerId) continue
      const group = groups.get(record.offerId) ?? []
      group.push(record)
      groups.set(record.offerId, group)
    }
    return groups
  }, [activeRecords])

  const createOfferRecords = useMemo(
    () => activeRecords.filter(record => record.kind === 'create_offer'),
    [activeRecords],
  )
  const createBorrowerAccountRecords = useMemo(
    () => activeRecords.filter(record => record.kind === 'create_borrower_account'),
    [activeRecords],
  )
  const offerRecordGroups = useMemo<OfferRecordGroup[]>(
    () => [...offerIdGroups.entries()],
    [offerIdGroups],
  )

  usePendingTxConfirmationTracking(activeRecords, updatePendingTx)

  useOfferCleanupPolling({
    offerGroups: offerRecordGroups,
    onRemove: removeByTxid,
    onChecked: markChecked,
  })
  useCreateOfferCleanupPolling({
    scriptPubkey,
    records: createOfferRecords,
    onCreated: handleCreatedOffer,
    onChecked: markChecked,
  })
  useCreateBorrowerAccountCleanupPolling({
    scriptPubkey,
    records: createBorrowerAccountRecords,
    onRemove: removeByTxid,
    onChecked: markChecked,
  })
  usePendingTxToasts(pendingTxs, surfacedTxids)
  const { privateTxs, savePrivateTx, updatePrivateTx, removePrivateTx } = usePrivateTxStore(
    scriptPubkey,
    privateCapable,
  )

  const contextValue = useMemo(
    () => ({
      pendingTxs,
      newlyCreatedOfferIds,
      highlightedCreatedOfferIds,
      isLoading,
      addPendingTx,
      updatePendingTx,
      removePendingTx,
      addSurfaceToast,
      startCreatedOfferHighlight,
      privateTxs,
      savePrivateTx,
      updatePrivateTx,
      removePrivateTx,
    }),
    [
      pendingTxs,
      newlyCreatedOfferIds,
      highlightedCreatedOfferIds,
      isLoading,
      addPendingTx,
      updatePendingTx,
      removePendingTx,
      addSurfaceToast,
      startCreatedOfferHighlight,
      privateTxs,
      savePrivateTx,
      updatePrivateTx,
      removePrivateTx,
    ],
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
