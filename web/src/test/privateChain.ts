// The parity fixture's private offer and its loan, served by a fake chain, for the tests of the
// private lending flows. Test-only: the app's tsconfig leaves `src/test` out.
import fs from 'node:fs'

import type { PrivateFlowDeps } from '@/privateLending/deps'
import { openAndVerifyOffer, type VerifiedOffer } from '@/privateLending/verify'
import { lwk, sources } from '@/test/lwk'
import { wasm } from '@/test/wasm'

// The parity fixture's offer and its loan on regtest: the acceptance, then one installment, which
// takes the borrower NFT from the creation's output 0 (the principal is never claimed).
export interface Fixture {
  borrower_master_blinding_key: string
  lender_master_blinding_key: string
  creation_tx: string
  installment_output_script_hash: string
  carry_asset_id: string
  loan: {
    acceptance_tx: string
    installment_txs: string[]
    loan_outpoint: string
    remaining: number
    debt_hashes: string[]
    loan_script_pubkeys: string[]
  }
  other_offer: { creation_tx: string }
  messages: { installment: string }
}

export const fixture = JSON.parse(
  fs.readFileSync(
    new URL('../../scripts/fixtures/private-lending-parity.json', import.meta.url),
    'utf-8',
  ),
) as Fixture

export const txidOf = (hex: string) => lwk.Transaction.fromString(hex).txid().toString()
export const creationTxid = txidOf(fixture.creation_tx)
export const acceptanceTxid = txidOf(fixture.loan.acceptance_tx)
export const installmentHex = fixture.loan.installment_txs[0]
export const installmentTxid = txidOf(installmentHex)
export const installmentLock = lwk.Transaction.fromString(installmentHex)
  .outputs[2].scriptPubkey()
  .toString()

/** The fixture's transactions, and the ones a test adds, served by txid as esplora would. */
export function fakeChain(...extra: string[]): { deps: PrivateFlowDeps; fetched: string[] } {
  const txs = new Map<string, string>()
  for (const hex of [
    fixture.creation_tx,
    fixture.loan.acceptance_tx,
    installmentHex,
    fixture.other_offer.creation_tx,
    ...extra,
  ]) {
    txs.set(txidOf(hex), hex)
  }
  const fetched: string[] = []
  const deps = {
    lwk,
    wasm,
    network: lwk.Network.regtestDefault(),
    networkName: 'regtest',
    sources,
    assets: { policy: OTHER_ASSET },
    // the flows read the fee rate only to build: a refusal before building never reaches it
    get feeRate(): number {
      throw new Error('the PSET build was reached')
    },
    fetchTx: async (txid: string) => {
      fetched.push(txid)
      const hex = txs.get(txid)
      if (hex === undefined) throw new Error(`fake chain: no transaction ${txid}`)
      return lwk.Transaction.fromString(hex)
    },
  } as unknown as PrivateFlowDeps
  return { deps, fetched }
}

export const keys = {
  borrower: wasm.LendingKey.fromMasterBlindingKey(fixture.borrower_master_blinding_key),
  lender: wasm.LendingKey.fromMasterBlindingKey(fixture.lender_master_blinding_key),
}

export function openOffer(
  role: 'borrower' | 'lender',
  creationTx = fixture.creation_tx,
): Promise<VerifiedOffer> {
  return openAndVerifyOffer(fakeChain().deps, role, keys[role], creationTx)
}

export const reversed = (hex: string) => (hex.match(/../g) ?? []).reverse().join('')
export const u32le = (n: number) => reversed(n.toString(16).padStart(8, '0'))
export const u64be = (n: bigint) => n.toString(16).padStart(16, '0')
export const pushLength = (hex: string) => (hex.length / 2).toString(16).padStart(2, '0')

/** Any asset that is not one of the offer's NFTs. */
export const OTHER_ASSET = '5ac9f65c0efcc4775e0baec4ec03abdde22473cd3cf33c0419ca290e0751b225'
export const WALLET_SCRIPT = '0014' + '71'.repeat(20)
/** `OP_RETURN "burn"`, as the flows burn an NFT. */
export const BURN_SCRIPT = '6a04' + Buffer.from('burn').toString('hex')

export interface StandInOutput {
  script: string
  /** The explicit asset, as `AssetId.toString()` shows it. */
  asset?: string
  value?: bigint
}

/**
 * A transaction that only stands in for a real one: explicit outputs and no witnesses, enough for
 * the walks, which read the outpoints its inputs spend and its outputs' scripts and assets.
 */
export function standIn(inputs: string[], outputs: StandInOutput[]): string {
  const ins = inputs.map(outpoint => {
    const [txid, vout] = outpoint.split(':')
    return reversed(txid) + u32le(Number(vout)) + '00' + 'ffffffff'
  })
  const outs = outputs.map(({ script, asset = OTHER_ASSET, value = 1_000n }) => {
    return '01' + reversed(asset) + '01' + u64be(value) + '00' + pushLength(script) + script
  })
  const count = (n: number) => n.toString(16).padStart(2, '0')
  return (
    '02000000' +
    '00' +
    count(ins.length) +
    ins.join('') +
    count(outs.length) +
    outs.join('') +
    '00000000'
  )
}
