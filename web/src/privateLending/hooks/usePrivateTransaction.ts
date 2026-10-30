// Runs a private lending transaction like `useStandardTransactionFlow` (build, sign, finalize,
// broadcast, with the same progress steps), but saves the finalized transaction before it is
// broadcast. A failed broadcast leaves it saved, and `retryBroadcast` sends that same hex again:
// a creation draws fresh NFTs on every build, so rebuilding would make a different offer.
import { Transaction } from '@lilbonekit/lwk-web'
import { useCallback } from 'react'

import { ApiError } from '@/api/errors'
import { broadcastTx } from '@/api/esplora/methods'
import { getStandardTransactionSteps } from '@/components/TransactionStepper/transactionSteps'
import { useLatestRef } from '@/hooks/useLatestRef'
import type { AsyncUpdatedPset, UpdatedPset } from '@/lwk/transaction'
import type { PrivateTxKind } from '@/providers/pendingTransactions/types'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'
import { useTxProgress } from '@/providers/txProgress/useTxProgress'
import { useWallet } from '@/providers/wallet/useWallet'
import { ErrorHandler } from '@/utils/errorHandler'

/** What the transaction acts on: a creation is its own offer; every other flow names one. */
export type PrivateTransactionTarget =
  | { kind: 'private_create_offer' }
  | { kind: Exclude<PrivateTxKind, 'private_create_offer'>; offerTxid: string }

export interface PrivateTransactionResult<TSummary> {
  txid: string
  summary: TSummary
}

/**
 * The broadcast of a saved transaction failed. The transaction stays saved: offer
 * `retryBroadcast(txid)`, never a rebuild.
 */
export class PrivateBroadcastError extends Error {
  readonly txid: string

  constructor(txid: string, cause: unknown) {
    super(ErrorHandler.describe(cause), { cause })
    this.name = 'PrivateBroadcastError'
    this.txid = txid
  }
}

// What a node answers for a transaction it already has: the earlier broadcast went through.
const ALREADY_BROADCAST =
  /txn-already-in-mempool|txn-already-known|already in block ?chain|txn-same-nonwitness-data-in-mempool/i

async function broadcastHex(txHex: string): Promise<void> {
  try {
    await broadcastTx(txHex)
  } catch (error) {
    if (error instanceof ApiError && error.body && ALREADY_BROADCAST.test(error.body)) return
    throw error
  }
}

export interface PrivateTransaction {
  /**
   * Builds, signs (through the wallet), finalizes (awaiting an async finalize such as the
   * creation's self-check), saves, then broadcasts. Nothing is broadcast unless the finalized
   * transaction was saved. Throws `PrivateBroadcastError` if only the broadcast failed.
   */
  run: <TSummary>(
    target: PrivateTransactionTarget,
    build: () => Promise<UpdatedPset<TSummary> | AsyncUpdatedPset<TSummary>>,
  ) => Promise<PrivateTransactionResult<TSummary>>
  /** Broadcasts the saved transaction `txid` again, as saved. Resolves to `txid`. */
  retryBroadcast: (txid: string) => Promise<string>
}

export function usePrivateTransaction(): PrivateTransaction {
  const { signPset, signerType, applyBroadcastTransaction } = useWallet()
  const { startTxProgress, setTxProgressError } = useTxProgress()
  const { privateTxs, savePrivateTx, updatePrivateTx } = usePendingTransactions()
  const privateTxsRef = useLatestRef(privateTxs)

  const broadcastSaved = useCallback(
    async (txid: string, tx: Transaction, txHex: string) => {
      try {
        await broadcastHex(txHex)
      } catch (error) {
        const broadcastError = new PrivateBroadcastError(txid, error)
        void updatePrivateTx(txid, { errorMessage: broadcastError.message })
        throw broadcastError
      }
      await updatePrivateTx(txid, { broadcastStatus: 'broadcast', errorMessage: undefined })
      applyBroadcastTransaction(tx)
    },
    [updatePrivateTx, applyBroadcastTransaction],
  )

  const run = useCallback<PrivateTransaction['run']>(
    async (target, build) => {
      try {
        const advance = startTxProgress(getStandardTransactionSteps(signerType))
        const { pset, finalize } = await build()

        await advance('signing')
        const signedPset = await signPset(pset)

        await advance('finalizing')
        const { finalizedTx, summary } = await finalize(signedPset)
        const txid = finalizedTx.txid().toString()
        const txHex = finalizedTx.toString()
        try {
          await savePrivateTx({
            txid,
            kind: target.kind,
            offerTxid: target.kind === 'private_create_offer' ? txid : target.offerTxid,
            txHex,
          })
        } catch (error) {
          throw new Error(
            'Could not save the signed transaction in this browser, so it was not broadcast.',
            { cause: error },
          )
        }

        await advance('broadcasting')
        await broadcastSaved(txid, finalizedTx, txHex)
        return { txid, summary }
      } catch (error) {
        setTxProgressError(error)
        throw error
      }
    },
    [startTxProgress, setTxProgressError, signerType, signPset, savePrivateTx, broadcastSaved],
  )

  const retryBroadcast = useCallback(
    async (txid: string): Promise<string> => {
      try {
        startTxProgress(
          getStandardTransactionSteps(signerType).filter(step => step.id === 'broadcasting'),
        )
        const record = privateTxsRef.current.find(saved => saved.txid === txid)
        if (!record) throw new Error(`No saved transaction ${txid} for this wallet`)
        const tx = Transaction.fromString(record.txHex)
        if (tx.txid().toString() !== txid) throw new Error(`The saved transaction is not ${txid}`)
        await broadcastSaved(txid, tx, record.txHex)
        return txid
      } catch (error) {
        setTxProgressError(error)
        throw error
      }
    },
    [startTxProgress, setTxProgressError, signerType, privateTxsRef, broadcastSaved],
  )

  return { run, retryBroadcast }
}
