// Runs a private lending transaction like `useStandardTransactionFlow` (build, sign, finalize,
// broadcast, with the same progress steps), but saves the finalized transaction before it is
// broadcast. A failed broadcast, or a failed check before it, leaves it saved, and
// `retryBroadcast` sends that same hex again: a creation draws fresh NFTs on every build, so
// rebuilding would make a different offer.
import { Transaction } from 'lwk_wasm'
import { useCallback } from 'react'

import { ApiError } from '@/api/errors'
import { broadcastTx } from '@/api/esplora/methods'
import { getStandardTransactionSteps } from '@/components/TransactionStepper/transactionSteps'
import { useLatestRef } from '@/hooks/useLatestRef'
import type { AsyncUpdatedPset, UpdatedPset } from '@/lwk/transaction'
import { PrivateBroadcastError, sendSaved } from '@/privateLending/sendSaved'
import type { CreationTerm, PrivateTxKind } from '@/providers/pendingTransactions/types'
import { usePendingTransactions } from '@/providers/pendingTransactions/usePendingTransactions'
import { useTxProgress } from '@/providers/txProgress/useTxProgress'
import { useWallet } from '@/providers/wallet/useWallet'

// Defined beside `sendSaved`, which tests load without React; the modals import it from here.
export { PrivateBroadcastError }

/**
 * What the transaction acts on: a creation is its own offer, saved with the term the borrower
 * chose; every other flow names one.
 */
export type PrivateTransactionTarget =
  | { kind: 'private_create_offer'; creationTerm: CreationTerm }
  | { kind: Exclude<PrivateTxKind, 'private_create_offer'>; offerTxid: string }

export interface PrivateTransactionResult<TSummary> {
  txid: string
  summary: TSummary
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
   * transaction was saved, and `beforeBroadcast` (if given) resolved just before. Throws
   * `PrivateBroadcastError` if the transaction was saved but `beforeBroadcast` or the broadcast
   * failed: it stays saved and unsent, for `retryBroadcast`.
   */
  run: <TSummary>(
    target: PrivateTransactionTarget,
    build: () => Promise<UpdatedPset<TSummary> | AsyncUpdatedPset<TSummary>>,
    beforeBroadcast?: () => Promise<void>,
  ) => Promise<PrivateTransactionResult<TSummary>>
  /**
   * Broadcasts the saved transaction `txid` again, as saved, once `beforeBroadcast` (if given)
   * resolved. Resolves to `txid`; throws `PrivateBroadcastError` if `beforeBroadcast` or the
   * broadcast failed.
   */
  retryBroadcast: (txid: string, beforeBroadcast?: () => Promise<void>) => Promise<string>
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
      // An accepted broadcast tracks the transaction afresh, from now: a retry after the sweep
      // gave up on the record (`failed`) must not leave it failed for good.
      await updatePrivateTx(txid, {
        broadcastStatus: 'broadcast',
        confirmationStatus: 'processing',
        createdAt: Date.now(),
        errorMessage: undefined,
      })
      applyBroadcastTransaction(tx)
    },
    [updatePrivateTx, applyBroadcastTransaction],
  )

  const run = useCallback<PrivateTransaction['run']>(
    async (target, build, beforeBroadcast) => {
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
            txHex,
            ...(target.kind === 'private_create_offer'
              ? { offerTxid: txid, creationTerm: target.creationTerm }
              : { offerTxid: target.offerTxid }),
          })
        } catch (error) {
          throw new Error(
            'Could not save the signed transaction in this browser, so it was not broadcast.',
            { cause: error },
          )
        }

        await sendSaved(txid, beforeBroadcast, async () => {
          await advance('broadcasting')
          await broadcastSaved(txid, finalizedTx, txHex)
        })
        return { txid, summary }
      } catch (error) {
        setTxProgressError(error)
        throw error
      }
    },
    [startTxProgress, setTxProgressError, signerType, signPset, savePrivateTx, broadcastSaved],
  )

  const retryBroadcast = useCallback(
    async (txid: string, beforeBroadcast?: () => Promise<void>): Promise<string> => {
      try {
        startTxProgress(
          getStandardTransactionSteps(signerType).filter(step => step.id === 'broadcasting'),
        )
        const record = privateTxsRef.current.find(saved => saved.txid === txid)
        if (!record) throw new Error(`No saved transaction ${txid} for this wallet`)
        const tx = Transaction.fromString(record.txHex)
        if (tx.txid().toString() !== txid) throw new Error(`The saved transaction is not ${txid}`)
        await sendSaved(txid, beforeBroadcast, () => broadcastSaved(txid, tx, record.txHex))
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
