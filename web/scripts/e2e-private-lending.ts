// Testnet end-to-end run of the private lending flows.
//   npx pnpm@10.33.0 e2e:private [stage...]
// Stages run in the order given; with none, every real stage runs (see `web/README.md`). Seed
// phrases come from `.env.e2e.local` and are never printed.
//
// Resuming: every transaction is finalized and saved to `.e2e-private/state.json` (status
// `built`) BEFORE it is broadcast, then marked `broadcast` and `confirmed`. A re-run
// rebroadcasts the saved hex of a `built`/`broadcast` stage ("already known" is success) and
// waits for its confirmation; it never builds that transaction again.
//
// Funding: every invocation first checks that both wallets hold, in confirmed coins, what the
// stages without a `confirmed` record still need (the sum of their `STAGE_NEEDS`, env.ts), and
// exits 1 naming each shortfall and the address to fund. Each stage checks its own need again
// right before it builds.
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import * as lwk from '@lilbonekit/lwk-web'

import { ApiError } from '@/api/errors'
import {
  fetchDirectory,
  fetchDirectoryEntry,
  fetchPrivateCandidate,
  fetchPrivateCandidates,
  indexerErrorMessage,
  type PrivateCandidate,
  putDirectoryEntry,
  requestDirectoryChallenge,
} from '@/api/indexer/private'
import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import type { PrivateFlowDeps } from '@/privateLending/deps'
import { registerInDirectory, removeFromDirectory } from '@/privateLending/directory'
import { buildPrivateAcceptance } from '@/privateLending/flows/acceptance'
import { buildPrivateCancellation } from '@/privateLending/flows/cancellation'
import { buildPrincipalClaim } from '@/privateLending/flows/claimPrincipal'
import { buildRepaymentClaim } from '@/privateLending/flows/claimRepayment'
import { buildPrivateCreation } from '@/privateLending/flows/creation'
import {
  buildPrivateLiquidation,
  ExpiryNotReachedError,
  type LiquidationParams,
} from '@/privateLending/flows/liquidation'
import { buildPrivateRepayment } from '@/privateLending/flows/repayment'
import { outpointOf } from '@/privateLending/flows/shared'
import { type InspectedOutput, inspectPset } from '@/privateLending/inspectPset'
import {
  CREATION_TX_MISMATCH,
  loadVerifiedOffer,
  type ScanResult,
  type ScanState,
  syncOffers,
} from '@/privateLending/scan'
import { openAndVerifyOffer, PrivateOfferError, type VerifiedOffer } from '@/privateLending/verify'
import {
  ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY,
  ASSET_AUTH_MAX_WEIGHT_TO_SATISFY,
} from '@/simplicity/asset-auth/witness'
import {
  ACCEPTANCE_INPUT,
  ACCEPTANCE_OUTPUT,
  CANCELLATION_INPUT,
  CANCELLATION_OUTPUT,
  CREATION_OUTPUT,
  LIQUIDATION_INPUT,
  LIQUIDATION_OUTPUT,
  NFT_AMOUNT,
  PRINCIPAL_CLAIM_INPUT,
  PRINCIPAL_CLAIM_OUTPUT,
  REPAYMENT_CLAIM_INPUT,
  REPAYMENT_CLAIM_OUTPUT,
  REPAYMENT_INPUT,
  REPAYMENT_OUTPUT,
} from '@/simplicity/private-lending/layout'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'
import { SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/script-auth/witness'
import * as wasm from '@/wasm/private-lending/private_lending_wasm'

import { createChain, submitStage } from './e2e/chain'
import {
  COLLATERAL,
  FEE_BUDGET,
  loadEnv,
  type Need,
  needsNothing,
  PRINCIPAL,
  REPAYMENT,
  SPLITS,
  type Stage,
  STAGE_NAMES,
  STAGE_NEEDS,
  sumNeeds,
  TESTNET_ASSETS,
  type Wallet,
} from './e2e/env'
import { type IndexerProxy, memoryScanStore, startIndexerProxy } from './e2e/indexer'
import { getRecord } from './e2e/state'
import { fingerprintGroups, flowDeps, initRuntime, type SeedWallet, seedWallet } from './e2e/wallet'

interface Context {
  chain: ReturnType<typeof createChain>
  wallets: Record<Wallet, SeedWallet>
  /** The indexer API that `scan` reads. */
  apiUrl: string
}

const NAMES: Wallet[] = ['borrower', 'lender']

function out(line = ''): void {
  process.stdout.write(`${line}\n`)
}

function confirmedBalance(wallet: SeedWallet, asset: string): bigint {
  let total = 0n
  for (const utxo of wallet.utxos()) {
    if (utxo.height() === undefined) continue
    const secrets = utxo.unblinded()
    if (secrets.asset().toString() === asset) total += secrets.value()
  }
  return total
}

function confirmedLbtcCoins(wallet: SeedWallet): number {
  return wallet
    .utxos()
    .filter(
      utxo =>
        utxo.height() !== undefined &&
        utxo.unblinded().asset().toString() === TESTNET_ASSETS.policy,
    ).length
}

/** The wallets' shortfalls against `needs`, one line each, with the address to fund. */
function shortfalls(ctx: Context, needs: Record<Wallet, Need>): string[] {
  const short: string[] = []
  for (const name of NAMES) {
    const wallet = ctx.wallets[name]
    const lbtc = confirmedBalance(wallet, TESTNET_ASSETS.policy)
    const test = confirmedBalance(wallet, TESTNET_ASSETS.principal)
    const need = needs[name]
    if (lbtc < need.lbtc) {
      short.push(`${name}: ${need.lbtc - lbtc} more tL-sats (has ${lbtc}, needs ${need.lbtc})`)
    }
    if (test < need.test) {
      short.push(`${name}: ${need.test - test} more TEST units (has ${test}, needs ${need.test})`)
    }
    if (lbtc < need.lbtc || test < need.test) short.push(`  fund ${wallet.address()}`)
  }
  return short
}

/**
 * Exits 1 unless the wallets cover every stage without a `confirmed` record: a `built` or
 * `broadcast` one still counts, as its coins are not spent until it confirms. A stage that needs
 * nothing (`scan`, which never has a record) is never left.
 */
function requireFunding(ctx: Context): void {
  const remaining = STAGE_NAMES.filter(
    stage => !needsNothing(stage) && getRecord(stage)?.status !== 'confirmed',
  )
  const short = shortfalls(ctx, sumNeeds(remaining))
  if (short.length > 0) {
    console.error(
      `\nUnderfunded for the stages left (${remaining.join(', ')}):\n` +
        short.map(line => `  ${line}`).join('\n'),
    )
    process.exit(1)
  }
}

/** Throws unless the wallets cover `stage`'s own need; run right before building it. */
function requireStageNeed(ctx: Context, stage: Stage): void {
  const short = shortfalls(ctx, STAGE_NEEDS[stage])
  if (short.length > 0) throw new Error(`${stage}: underfunded\n${short.join('\n')}`)
}

async function walletsStage(ctx: Context): Promise<void> {
  for (const name of NAMES) {
    const wallet = ctx.wallets[name]
    out(name)
    out(`  address     ${wallet.address()}`)
    out(`  tL-BTC      ${confirmedBalance(wallet, TESTNET_ASSETS.policy)} sats (confirmed)`)
    out(`  TEST        ${confirmedBalance(wallet, TESTNET_ASSETS.principal)} units (confirmed)`)
    out(`  lending key ${fingerprintGroups(wallet.lendingKey.fingerprint())}`)
  }

  for (const name of NAMES) {
    const wallet = ctx.wallets[name]
    const stage = `wallets-split-${name}`
    const { coins: target, amount } = SPLITS[name]
    const coins = confirmedLbtcCoins(wallet)
    const recorded = await resumeRecorded(ctx, stage)
    if (recorded) {
      await wallet.sync()
      continue
    }
    if (coins >= target) {
      out(`${name}: ${coins} confirmed tL-BTC coins, no split needed`)
      continue
    }
    const needed = BigInt(target) * amount + FEE_BUDGET
    const have = confirmedBalance(wallet, TESTNET_ASSETS.policy)
    if (have < needed) {
      console.error(`${name}: cannot split, needs ${needed} tL-sats, has ${have}`)
      process.exit(1)
    }
    out(`${name}: ${coins} confirmed tL-BTC coins, splitting into ${target} x ${amount}`)
    await submitStage(
      ctx.chain,
      stage,
      () => {
        const address = new lwk.Address(wallet.address())
        let builder = new lwk.TxBuilder(wallet.network)
        for (let i = 0; i < target; i += 1) builder = builder.addLbtcRecipient(address, amount)
        const pset = wallet.signer.sign(builder.finish(wallet.wollet))
        return wallet.wollet.finalize(pset).extractTx().toString()
      },
      out,
    )
    await wallet.sync()
    out(`${name}: ${confirmedLbtcCoins(wallet)} confirmed tL-BTC coins`)
  }
  out('\nwallets: ok')
}

// A stage with a saved record is resumed from it, never rebuilt.
async function resumeRecorded(ctx: Context, stage: string): Promise<boolean> {
  if (!getRecord(stage)) return false
  await submitStage(
    ctx.chain,
    stage,
    () => {
      throw new Error('unreachable: a record exists')
    },
    out,
  )
  return true
}

/** Blocks from the tip to an e2e offer's loan expiration. */
const OFFER_EXPIRY_BLOCKS = 1_440

function compareValues(a: lwk.WalletTxOut, b: lwk.WalletTxOut): number {
  const diff = a.unblinded().value() - b.unblinded().value()
  return diff < 0n ? -1 : diff > 0n ? 1 : 0
}

/**
 * The borrower's coins for a creation, all confirmed tL-BTC: the two smallest issue the NFTs,
 * the next ones cover the collateral and the fee.
 */
function creationCoins(wallet: SeedWallet): {
  firstInput: lwk.WalletTxOut
  lenderNftCoin: lwk.WalletTxOut
  collateralCoins: lwk.WalletTxOut[]
} {
  const coins = wallet
    .utxos()
    .filter(
      utxo =>
        utxo.height() !== undefined &&
        utxo.unblinded().asset().toString() === TESTNET_ASSETS.collateral,
    )
    .sort(compareValues)
  const [firstInput, lenderNftCoin, ...rest] = coins
  const needed = COLLATERAL + FEE_BUDGET
  const collateralCoins: lwk.WalletTxOut[] = []
  let total = 0n
  for (const coin of rest) {
    if (total >= needed) break
    collateralCoins.push(coin)
    total += coin.unblinded().value()
  }
  if (!firstInput || !lenderNftCoin || total < needed) {
    throw new Error(
      `borrower: a creation needs two NFT coins and ${needed} tL-sats more in confirmed tL-BTC coins`,
    )
  }
  return { firstInput, lenderNftCoin, collateralCoins }
}

/** The NFTs a creation PSET issues and the nonce of its pending offer, output 3. */
function creationIdentity(pset: lwk.Pset): {
  borrowerNft: string
  lenderNft: string
  nonce: string
} {
  const outputs = inspectPset(wasm, pset.toString()).outputs
  const borrowerNftOutput = outputs[CREATION_OUTPUT.borrowerNft]
  const lenderNftOutput = outputs[CREATION_OUTPUT.lenderNft]
  const offerOutput = outputs[CREATION_OUTPUT.pendingOffer]
  if (
    offerOutput === undefined ||
    borrowerNftOutput.asset === null ||
    lenderNftOutput.asset === null ||
    offerOutput.ecdhPubkey === null
  ) {
    throw new Error('the creation PSET has no explicit NFTs at outputs 0 and 1 or no nonce at 3')
  }
  return {
    borrowerNft: borrowerNftOutput.asset,
    lenderNft: lenderNftOutput.asset,
    nonce: offerOutput.ecdhPubkey,
  }
}

/** One line per output: what it holds and how it is blinded. */
function describeOutputs(pset: lwk.Pset, nfts: { borrowerNft: string; lenderNft: string }): void {
  const names: Record<string, string> = {
    [TESTNET_ASSETS.policy]: 'tL-BTC',
    [TESTNET_ASSETS.principal]: 'TEST',
    [nfts.borrowerNft]: 'borrower NFT',
    [nfts.lenderNft]: 'lender NFT',
  }
  inspectPset(wasm, pset.toString()).outputs.forEach((output, index) => {
    const kind =
      output.script === '' ? 'fee' : output.script.startsWith('6a') ? 'OP_RETURN' : 'script'
    const asset =
      output.asset === null ? 'confidential asset' : (names[output.asset] ?? output.asset)
    const blinding =
      output.blindingKey === null
        ? 'explicit'
        : `key ${output.blindingKey.slice(0, 10)}…, blinder ${output.blinderIndex}, ` +
          (output.ecdhPubkey === null
            ? 'unblinded'
            : `nonce ${output.ecdhPubkey.slice(0, 10)}…, blind proofs ` +
              `${output.hasBlindValueProof && output.hasBlindAssetProof ? 'yes' : 'no'}`)
    out(`  ${index} ${kind.padEnd(9)} ${output.amount} ${asset} (${blinding})`)
  })
}

/**
 * Builds a creation from the borrower to the lender twice from the same coins, and checks that
 * the rebuild is a fresh offer (Review Focus): new NFTs and a new output 3 nonce. Each build runs
 * the builder's layout asserts. Returns the second build; the first is never signed.
 */
async function buildFreshCreation(
  ctx: Context,
  expiryBlocks: number,
): Promise<Awaited<ReturnType<typeof buildPrivateCreation>>> {
  const { borrower, lender } = ctx.wallets
  const deps = flowDeps(borrower, ctx.chain)
  const tip = await ctx.chain.tipHeight()
  const params = {
    borrower: borrower.lendingKey,
    lender: lender.lendingKey.xOnlyPublicKey(),
    ...creationCoins(borrower),
    collateralAmount: COLLATERAL,
    principalAmount: PRINCIPAL,
    repaymentAmount: REPAYMENT,
    loanExpirationTime: tip + expiryBlocks,
    borrowerNftReceiver: new lwk.Address(borrower.address()),
  }

  const discarded = creationIdentity((await buildPrivateCreation(deps, params)).pset)
  const built = await buildPrivateCreation(deps, params)
  const kept = creationIdentity(built.pset)
  if (discarded.borrowerNft === kept.borrowerNft || discarded.lenderNft === kept.lenderNft) {
    throw new Error('two creations built from the same coins issue the same NFTs')
  }
  if (discarded.nonce === kept.nonce) {
    throw new Error('two creations built from the same coins share the output 3 nonce')
  }
  out('two builds from the same coins differ:')
  out(`  borrower NFT ${discarded.borrowerNft} | ${kept.borrowerNft}`)
  out(`  lender NFT   ${discarded.lenderNft} | ${kept.lenderNft}`)
  out(`  nonce        ${discarded.nonce} | ${kept.nonce}`)
  out('blinded creation PSET (second build):')
  describeOutputs(built.pset, kept)
  return built
}

/** Builds (only without a record), saves and broadcasts a creation; returns its txid. */
async function submitCreation(
  ctx: Context,
  stage: string,
  need: Stage,
  expiryBlocks: number,
): Promise<string> {
  let hex: string | undefined
  if (!getRecord(stage)) {
    requireStageNeed(ctx, need)
    const built = await buildFreshCreation(ctx, expiryBlocks)
    const { finalizedTx, summary } = await built.finalize(
      ctx.wallets.borrower.signer.sign(built.pset),
    )
    out(`borrower self-check: ok, offer ${summary.offerOutpoint}`)
    hex = finalizedTx.toString()
  }
  const txid = await submitStage(
    ctx.chain,
    stage,
    () => {
      if (hex === undefined) throw new Error('unreachable: a record exists')
      return hex
    },
    out,
  )
  await ctx.wallets.borrower.sync()
  return txid
}

/** The lender fetches the creation, verifies it through the gate and shows its terms. */
async function lenderView(ctx: Context, txid: string): Promise<void> {
  const { borrower, lender } = ctx.wallets
  const creationTx = await ctx.chain.fetchTx(txid)
  const offer = await openAndVerifyOffer(
    flowDeps(lender, ctx.chain),
    'lender',
    lender.lendingKey,
    creationTx.toString(),
  )
  const opened = offer.opened
  const expected: [string, unknown, unknown][] = [
    ['borrower key', opened.borrowerPublicKey(), borrower.lendingKey.xOnlyPublicKey()],
    ['lender key', opened.lenderPublicKey(), lender.lendingKey.xOnlyPublicKey()],
    ['collateral asset', opened.collateralAsset(), TESTNET_ASSETS.collateral],
    ['collateral', opened.collateralAmount(), COLLATERAL],
    ['principal asset', opened.principalAsset(), TESTNET_ASSETS.principal],
    ['principal', opened.principalAmount(), PRINCIPAL],
    ['repayment', opened.repaymentAmount(), REPAYMENT],
  ]
  for (const [label, actual, wanted] of expected) {
    if (actual !== wanted) throw new Error(`the lender sees ${label} ${actual}, not ${wanted}`)
  }

  out('the lender sees (verified):')
  out(`  from         ${fingerprintGroups(wasm.keyFingerprint(opened.borrowerPublicKey()))}`)
  out(`  collateral   ${opened.collateralAmount()} tL-sats`)
  out(`  principal    ${opened.principalAmount()} TEST units`)
  out(`  repayment    ${opened.repaymentAmount()} TEST units`)
  out(`  interest     ${opened.repaymentAmount() - opened.principalAmount()} TEST units`)
  out(`  expires at   block ${opened.loanExpirationTime()}`)
  out(`  offer        ${txid}:${CREATION_OUTPUT.pendingOffer}`)
  out(`  borrower NFT ${opened.borrowerNft()}`)
  out(`  lender NFT   ${opened.lenderNft()}`)
}

async function createStage(ctx: Context): Promise<void> {
  const txid = await submitCreation(ctx, 'create', 'create', OFFER_EXPIRY_BLOCKS)
  await lenderView(ctx, txid)
  out('\ncreate: ok')
}

/** A creation built twice and checked, but never signed, broadcast or saved. */
async function createDryStage(ctx: Context): Promise<void> {
  requireStageNeed(ctx, 'create')
  await buildFreshCreation(ctx, OFFER_EXPIRY_BLOCKS)
  out('\ncreate-dry: ok (nothing signed, broadcast or saved)')
}

/** The records of the e2e offers' creations, and the stage that runs each. */
const CREATION_STAGES = {
  create: 'create',
  'cancel-create': 'cancel',
  'liquidate-create': 'liquidate',
} as const

type CreationRecord = keyof typeof CREATION_STAGES

/** The `create` offer, fetched from chain and opened through the gate as `role`. */
async function loadCreatedOffer(ctx: Context, role: Wallet): Promise<VerifiedOffer> {
  return loadOffer(ctx, 'create', role)
}

/** The offer of a confirmed creation record, fetched from chain and opened as `role`. */
async function loadOffer(
  ctx: Context,
  creation: CreationRecord,
  role: Wallet,
): Promise<VerifiedOffer> {
  const record = getRecord(creation)
  if (record?.status !== 'confirmed') {
    throw new Error(`no confirmed ${creation}: run the ${CREATION_STAGES[creation]} stage`)
  }
  const wallet = ctx.wallets[role]
  const creationTx = await ctx.chain.fetchTx(record.txid)
  return openAndVerifyOffer(
    flowDeps(wallet, ctx.chain),
    role,
    wallet.lendingKey,
    creationTx.toString(),
  )
}

/** Confirmed coins of `asset`, smallest first, until they hold `amount`. */
function pickCoins(
  wallet: SeedWallet,
  asset: string,
  amount: bigint,
  label: string,
): lwk.WalletTxOut[] {
  const coins = wallet
    .utxos()
    .filter(utxo => utxo.height() !== undefined && utxo.unblinded().asset().toString() === asset)
    .sort(compareValues)
  const picked: lwk.WalletTxOut[] = []
  let total = 0n
  for (const coin of coins) {
    if (total >= amount) break
    picked.push(coin)
    total += coin.unblinded().value()
  }
  if (total < amount) throw new Error(`${label}: needs ${amount} in confirmed coins, has ${total}`)
  return picked
}

/** Whether an inspected output carries exactly the pinned commitments (`PinnedOutput::matches`). */
function pinnedMatches(
  pinned: wasm.PinnedOutputInfo,
  output: InspectedOutput | undefined,
): boolean {
  return (
    output !== undefined &&
    output.assetCommitment === pinned.assetCommitment &&
    output.amountCommitment === pinned.valueCommitment
  )
}

function scriptHash(scriptHex: string): string {
  return new lwk.Script(scriptHex).jet_sha256_hex()
}

/**
 * The stage's own checks of a blinded acceptance PSET, independent of the builder's: the pinned
 * outputs by their commitments and scripts, and the lender NFT to the lender, explicit.
 */
function assertAcceptanceOutputs(
  pset: lwk.Pset,
  offer: VerifiedOffer,
  lenderNftScript: string,
): void {
  const opened = offer.opened
  const outputs = inspectPset(wasm, pset.toString()).outputs
  const active = outputs[ACCEPTANCE_OUTPUT.activeOffer]
  const principal = outputs[ACCEPTANCE_OUTPUT.principal]
  const lenderNft = outputs[ACCEPTANCE_OUTPUT.lenderNft]
  const checks: [string, boolean][] = [
    [
      'output 0 is the active offer with the pinned active collateral',
      pinnedMatches(opened.pinned(wasm.PinnedRole.ActiveCollateral), active) &&
        active.script === offer.scripts.activeOffer.toString() &&
        active.blindingKey === opened.borrowerBlindingKey() &&
        active.ecdhPubkey !== null,
    ],
    [
      'output 1 is the principal asset_auth with the pinned principal',
      pinnedMatches(opened.pinned(wasm.PinnedRole.Principal), principal) &&
        scriptHash(principal.script) === offer.scripts.principalOutputScriptHash &&
        principal.blindingKey === opened.borrowerBlindingKey() &&
        principal.ecdhPubkey !== null,
    ],
    [
      'output 2 is the lender NFT to the lender, explicit',
      lenderNft !== undefined &&
        lenderNft.script === lenderNftScript &&
        lenderNft.asset === opened.lenderNft() &&
        lenderNft.amount === NFT_AMOUNT &&
        lenderNft.blindingKey === null &&
        lenderNft.assetCommitment === null &&
        lenderNft.amountCommitment === null,
    ],
  ]
  for (const [what, ok] of checks) {
    if (!ok) throw new Error(`acceptance PSET: not true that ${what}`)
    out(`  ok: ${what}`)
  }
}

/**
 * The stage's own checks of a blinded principal claim PSET: the borrower NFT back to the borrower,
 * explicit, and the principal to the borrower's wallet, blinded to it.
 */
function assertClaimOutputs(pset: lwk.Pset, offer: VerifiedOffer, receiver: lwk.Address): void {
  const opened = offer.opened
  const outputs = inspectPset(wasm, pset.toString()).outputs
  const nft = outputs[PRINCIPAL_CLAIM_OUTPUT.borrowerNft]
  const principal = outputs[PRINCIPAL_CLAIM_OUTPUT.principal]
  const checks: [string, boolean][] = [
    [
      'output 0 is the borrower NFT to the borrower, explicit',
      nft !== undefined &&
        nft.script === receiver.toUnconfidential().scriptPubkey().toString() &&
        nft.asset === opened.borrowerNft() &&
        nft.amount === NFT_AMOUNT &&
        nft.blindingKey === null &&
        nft.assetCommitment === null &&
        nft.amountCommitment === null,
    ],
    [
      'output 1 is the principal to the borrower, blinded',
      principal !== undefined &&
        principal.script === receiver.scriptPubkey().toString() &&
        principal.asset === opened.principalAsset() &&
        principal.amount === opened.principalAmount() &&
        principal.blindingKey !== null &&
        principal.assetCommitment !== null &&
        principal.amountCommitment !== null &&
        principal.ecdhPubkey !== null,
    ],
  ]
  for (const [what, ok] of checks) {
    if (!ok) throw new Error(`principal claim PSET: not true that ${what}`)
    out(`  ok: ${what}`)
  }
}

/** The weight a script witness adds: the stack's serialization, one weight unit per byte. */
function witnessWeight(items: string[]): number {
  const varint = (n: number): number => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5)
  return items.reduce(
    (total, item) => total + varint(item.length / 2) + item.length / 2,
    varint(items.length),
  )
}

/**
 * The index of the wallet's receive address whose unconfidential script is `script`, up to the
 * last unused one; undefined if none is.
 */
function walletAddressIndex(wallet: SeedWallet, script: string): number | undefined {
  const lastUnused = wallet.wollet.address(null).index()
  for (let index = 0; index <= lastUnused; index += 1) {
    const address = wallet.wollet.address(index).address().toUnconfidential()
    if (address.scriptPubkey().toString() === script) return index
  }
  return undefined
}

/** An input whose witness weight is checked against the constant its builder gives LWK. */
interface WeightedInput {
  index: number
  name: string
  limit: number
}

/**
 * Prints the witness weight of the given inputs of a broadcast transaction, and throws unless
 * each is at most the max-weight-to-satisfy its builder gives LWK for the fee.
 */
async function assertWitnessWeights(
  ctx: Context,
  txid: string,
  inputs: WeightedInput[],
): Promise<void> {
  checkWitnessWeights(
    await ctx.chain.fetchWitnesses(txid),
    inputs,
    'witness weights (serialized script witness, WU):',
  )
}

/**
 * The same check on a finalized transaction before it is saved or broadcast: LWK sized its fee
 * with these constants, so a heavier witness would pay less than the fee rate.
 */
function assertFinalizedWeights(tx: lwk.Transaction, inputs: WeightedInput[]): void {
  checkWitnessWeights(
    tx.inputs.map(input => input.witness().scriptWitness),
    inputs,
    'witness weights of the finalized transaction (WU):',
  )
}

function checkWitnessWeights(witnesses: string[][], inputs: WeightedInput[], title: string): void {
  out(title)
  for (const { index, name, limit } of inputs) {
    const items = witnesses[index] ?? []
    const weight = witnessWeight(items)
    const sizes = items.map(item => item.length / 2).join(' + ')
    out(`  input ${index} ${name.padEnd(28)} ${weight} <= ${limit} (items ${sizes})`)
    if (items.length === 0 || weight > limit) {
      throw new Error(`input ${index} (${name}) weighs ${weight}, over its constant ${limit}`)
    }
  }
}

/** The acceptance's inputs that LWK sized with a max-weight-to-satisfy constant. */
const ACCEPTANCE_WEIGHTS: WeightedInput[] = [
  {
    index: ACCEPTANCE_INPUT.offer,
    name: 'offer (OfferAcceptance)',
    limit: PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.OfferAcceptance,
  },
  {
    index: ACCEPTANCE_INPUT.lenderNft,
    name: 'lender NFT lock (script_auth)',
    limit: SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY,
  },
]

/**
 * The lender's acceptance of an offer: built, checked by the stage, signed and finalized (which
 * runs the covenants). The caller saves and broadcasts it, or not.
 */
async function buildSignedAcceptance(
  ctx: Context,
  offer: VerifiedOffer,
): Promise<{ hex: string; txid: string }> {
  const { lender } = ctx.wallets
  const lenderNftReceiver = new lwk.Address(lender.address())
  const principalCoins = pickCoins(lender, TESTNET_ASSETS.principal, PRINCIPAL, 'lender principal')
  const feeCoins = pickCoins(lender, TESTNET_ASSETS.policy, FEE_BUDGET, 'lender fee')
  out(`principal coins ${principalCoins.map(outpointOf).join(', ')}`)
  out(`fee coins       ${feeCoins.map(outpointOf).join(', ')}`)

  const built = await buildPrivateAcceptance(flowDeps(lender, ctx.chain), offer, {
    principalCoins,
    feeCoins,
    lenderNftReceiver,
  })
  out('blinded acceptance PSET:')
  describeOutputs(built.pset, {
    borrowerNft: offer.opened.borrowerNft(),
    lenderNft: offer.opened.lenderNft(),
  })
  assertAcceptanceOutputs(
    built.pset,
    offer,
    lenderNftReceiver.toUnconfidential().scriptPubkey().toString(),
  )
  const { finalizedTx, summary } = built.finalize(lender.signer.sign(built.pset))
  assertFinalizedWeights(finalizedTx, ACCEPTANCE_WEIGHTS)
  out(
    `finalized: active offer ${summary.activeOfferOutpoint}, principal ${summary.principalOutpoint}`,
  )
  return { hex: finalizedTx.toString(), txid: finalizedTx.txid().toString() }
}

/**
 * The lender's acceptance of `offer` under the record `stage`: built only without a record, saved,
 * broadcast (then `afterBroadcast` runs) and confirmed, then checked on chain. Returns its txid.
 */
async function submitAcceptance(
  ctx: Context,
  stage: 'accept' | 'liquidate-accept',
  offer: VerifiedOffer,
  afterBroadcast?: (txid: string) => Promise<void>,
): Promise<string> {
  let hex: string | undefined
  if (!getRecord(stage)) {
    requireStageNeed(ctx, stage)
    hex = (await buildSignedAcceptance(ctx, offer)).hex
  }
  const txid = await submitStage(
    ctx.chain,
    stage,
    () => {
      if (hex === undefined) throw new Error('unreachable: a record exists')
      return hex
    },
    out,
    afterBroadcast,
  )
  await ctx.wallets.lender.sync()

  // The lender NFT is an explicit output, which LWK does not list among the wallet's coins.
  const acceptanceTx = await ctx.chain.fetchTx(txid)
  const lenderNft = acceptanceTx.outputs[ACCEPTANCE_OUTPUT.lenderNft]
  if (
    lenderNft?.asset()?.toString() !== offer.opened.lenderNft() ||
    lenderNft.value() !== NFT_AMOUNT ||
    walletAddressIndex(ctx.wallets.lender, lenderNft.scriptPubkey().toString()) === undefined
  ) {
    throw new Error('the confirmed acceptance does not pay the lender NFT to the lender')
  }
  out(
    `lender NFT ${offer.opened.lenderNft()} at ${txid}:${ACCEPTANCE_OUTPUT.lenderNft} ` +
      '(a lender address)',
  )
  await assertWitnessWeights(ctx, txid, ACCEPTANCE_WEIGHTS)
  return txid
}

async function acceptStage(ctx: Context): Promise<void> {
  await submitAcceptance(ctx, 'accept', await loadCreatedOffer(ctx, 'lender'))
  out('\naccept: ok')
}

/** An acceptance built, checked, signed and finalized, but never saved or broadcast. */
async function acceptDryStage(ctx: Context): Promise<void> {
  requireStageNeed(ctx, 'accept')
  const { txid } = await buildSignedAcceptance(ctx, await loadCreatedOffer(ctx, 'lender'))
  out(`\naccept-dry: ok (${txid} finalized, not saved or broadcast)`)
}

/** The borrower NFT's outpoint: creation output 0, or the claim's output 0 once it confirmed. */
function borrowerNftOutpoint(): string {
  const claim = getRecord('claim-principal')
  if (claim?.status === 'confirmed') return `${claim.txid}:${PRINCIPAL_CLAIM_OUTPUT.borrowerNft}`
  const create = getRecord('create')
  if (!create) throw new Error('no offer: run the create stage')
  return `${create.txid}:${CREATION_OUTPUT.borrowerNft}`
}

/** The txid of `stage`, which must be confirmed. */
function requireConfirmed(stage: Stage): string {
  const record = getRecord(stage)
  if (record?.status !== 'confirmed') throw new Error(`no confirmed ${stage}: run that stage`)
  return record.txid
}

function requireAcceptance(): string {
  return requireConfirmed('accept')
}

async function buildSignedClaim(
  ctx: Context,
  offer: VerifiedOffer,
  acceptTxid: string,
): Promise<{ hex: string; txid: string }> {
  const { borrower } = ctx.wallets
  const receiver = new lwk.Address(borrower.address())
  const feeCoins = pickCoins(borrower, TESTNET_ASSETS.policy, FEE_BUDGET, 'borrower fee')
  out(`fee coins ${feeCoins.map(outpointOf).join(', ')}`)

  const built = await buildPrincipalClaim(flowDeps(borrower, ctx.chain), offer, {
    principalOutpoint: `${acceptTxid}:${ACCEPTANCE_OUTPUT.principal}`,
    borrowerNftOutpoint: borrowerNftOutpoint(),
    feeCoins,
    receiver,
  })
  out('blinded principal claim PSET:')
  describeOutputs(built.pset, {
    borrowerNft: offer.opened.borrowerNft(),
    lenderNft: offer.opened.lenderNft(),
  })
  assertClaimOutputs(built.pset, offer, receiver)
  const { finalizedTx, summary } = built.finalize(borrower.signer.sign(built.pset))
  out(`finalized: principal to ${summary.principalOutpoint}`)
  return { hex: finalizedTx.toString(), txid: finalizedTx.txid().toString() }
}

/**
 * Syncs until the wallet lists `outpoint` among its confirmed outputs, spent or not: a re-run
 * checks a stage whose coin a later stage may have spent (the repayment spends the claimed
 * principal).
 */
async function waitForWalletCoin(wallet: SeedWallet, outpoint: string): Promise<lwk.WalletTxOut> {
  for (let attempt = 0; ; attempt += 1) {
    await wallet.sync()
    const coin = wallet.wollet
      .txos()
      .find(txo => outpointOf(txo) === outpoint && txo.height() !== undefined)
    if (coin) return coin
    if (attempt >= 11) throw new Error(`the wallet does not list ${outpoint} as a confirmed output`)
    await new Promise(resolve => setTimeout(resolve, 10_000))
  }
}

async function claimPrincipalStage(ctx: Context): Promise<void> {
  const { borrower } = ctx.wallets
  const acceptTxid = requireAcceptance()
  const offer = await loadCreatedOffer(ctx, 'borrower')
  let hex: string | undefined
  let before: bigint | undefined
  if (!getRecord('claim-principal')) {
    requireStageNeed(ctx, 'claim-principal')
    before = confirmedBalance(borrower, TESTNET_ASSETS.principal)
    hex = (await buildSignedClaim(ctx, offer, acceptTxid)).hex
  }
  const txid = await submitStage(
    ctx.chain,
    'claim-principal',
    () => {
      if (hex === undefined) throw new Error('unreachable: a record exists')
      return hex
    },
    out,
  )

  const claimed = `${txid}:${PRINCIPAL_CLAIM_OUTPUT.principal}`
  const coin = await waitForWalletCoin(borrower, claimed)
  const secrets = coin.unblinded()
  if (
    secrets.asset().toString() !== offer.opened.principalAsset() ||
    secrets.value() !== offer.opened.principalAmount()
  ) {
    throw new Error(`${claimed} holds ${secrets.value()} of ${secrets.asset().toString()}`)
  }
  out(`the borrower's wallet received ${claimed}, ${secrets.value()} TEST units`)
  const after = confirmedBalance(borrower, TESTNET_ASSETS.principal)
  if (before !== undefined) {
    out(`borrower TEST (confirmed): ${before} -> ${after}`)
    if (after - before !== offer.opened.principalAmount()) {
      throw new Error(`the borrower's TEST balance rose by ${after - before}, not the principal`)
    }
  } else {
    out(`borrower TEST (confirmed): ${after}`)
  }
  await assertWitnessWeights(ctx, txid, [
    {
      index: PRINCIPAL_CLAIM_INPUT.principal,
      name: 'principal (asset_auth)',
      limit: ASSET_AUTH_MAX_WEIGHT_TO_SATISFY,
    },
    {
      index: PRINCIPAL_CLAIM_INPUT.borrowerNft,
      name: 'borrower NFT (p2wpkh)',
      limit: EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY,
    },
  ])
  out('\nclaim-principal: ok')
}

/** A principal claim built, checked, signed and finalized, but never saved or broadcast. */
async function claimPrincipalDryStage(ctx: Context): Promise<void> {
  requireStageNeed(ctx, 'claim-principal')
  const offer = await loadCreatedOffer(ctx, 'borrower')
  const { txid } = await buildSignedClaim(ctx, offer, requireAcceptance())
  out(`\nclaim-principal-dry: ok (${txid} finalized, not saved or broadcast)`)
}

/** Whether an inspected output is an explicit OP_RETURN that burns exactly one unit of `nft`. */
function burnsNft(output: InspectedOutput | undefined, nft: string): boolean {
  return (
    output !== undefined &&
    output.script.startsWith('6a') &&
    output.asset === nft &&
    output.amount === NFT_AMOUNT &&
    output.blindingKey === null &&
    output.assetCommitment === null &&
    output.amountCommitment === null
  )
}

/** Whether a confirmed transaction's output `vout` is an OP_RETURN holding one explicit `nft`. */
function burnsNftOnChain(tx: lwk.Transaction, vout: number, nft: string): boolean {
  const output = tx.outputs[vout]
  return (
    output !== undefined &&
    output.scriptPubkey().toString().startsWith('6a') &&
    output.asset()?.toString() === nft &&
    output.value() === NFT_AMOUNT
  )
}

/**
 * The stage's own checks of a blinded repayment PSET: the borrower NFT burned, the pinned
 * repayment at the offer's repayment asset_auth, blinded to the lender, and the collateral back
 * to the borrower, blinded to its wallet.
 */
function assertRepaymentOutputs(
  pset: lwk.Pset,
  offer: VerifiedOffer,
  collateralReceiver: lwk.Address,
): void {
  const opened = offer.opened
  const outputs = inspectPset(wasm, pset.toString()).outputs
  const repayment = outputs[REPAYMENT_OUTPUT.repayment]
  const collateral = outputs[REPAYMENT_OUTPUT.collateral]
  const checks: [string, boolean][] = [
    [
      'output 0 burns the borrower NFT, explicit',
      burnsNft(outputs[REPAYMENT_OUTPUT.borrowerNftBurn], opened.borrowerNft()),
    ],
    [
      'output 1 is the repayment asset_auth with the pinned repayment, blinded to the lender',
      pinnedMatches(opened.pinned(wasm.PinnedRole.Repayment), repayment) &&
        scriptHash(repayment.script) === offer.scripts.repaymentOutputScriptHash &&
        repayment.blindingKey === opened.lenderBlindingKey() &&
        repayment.ecdhPubkey !== null,
    ],
    [
      'output 2 is the collateral to the borrower, blinded',
      collateral !== undefined &&
        collateral.script === collateralReceiver.scriptPubkey().toString() &&
        collateral.asset === opened.collateralAsset() &&
        collateral.amount === opened.collateralAmount() &&
        collateral.blindingKey !== null &&
        collateral.assetCommitment !== null &&
        collateral.amountCommitment !== null &&
        collateral.ecdhPubkey !== null,
    ],
  ]
  for (const [what, ok] of checks) {
    if (!ok) throw new Error(`repayment PSET: not true that ${what}`)
    out(`  ok: ${what}`)
  }
}

/** The repayment's inputs that LWK sized with a max-weight-to-satisfy constant. */
const REPAYMENT_WEIGHTS: WeightedInput[] = [
  {
    index: REPAYMENT_INPUT.borrowerNft,
    name: 'borrower NFT (p2wpkh)',
    limit: EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY,
  },
  {
    index: REPAYMENT_INPUT.offer,
    name: 'offer (FullRepayment)',
    limit: PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.FullRepayment,
  },
]

/**
 * The borrower's full repayment of the `create` offer, accepted and with its principal claimed:
 * built, checked by the stage, signed and finalized (which runs the covenant).
 */
async function buildSignedRepayment(
  ctx: Context,
  offer: VerifiedOffer,
  acceptTxid: string,
): Promise<{ hex: string; txid: string }> {
  const { borrower } = ctx.wallets
  const collateralReceiver = new lwk.Address(borrower.address())
  const principalCoins = pickCoins(
    borrower,
    TESTNET_ASSETS.principal,
    offer.opened.repaymentAmount(),
    'borrower repayment',
  )
  const feeCoins = pickCoins(borrower, TESTNET_ASSETS.policy, FEE_BUDGET, 'borrower fee')
  out(`principal coins ${principalCoins.map(outpointOf).join(', ')}`)
  out(`fee coins       ${feeCoins.map(outpointOf).join(', ')}`)

  const built = await buildPrivateRepayment(flowDeps(borrower, ctx.chain), offer, {
    activeOfferOutpoint: `${acceptTxid}:${ACCEPTANCE_OUTPUT.activeOffer}`,
    borrowerNftOutpoint: borrowerNftOutpoint(),
    principalCoins,
    feeCoins,
    collateralReceiver,
  })
  out('blinded repayment PSET:')
  describeOutputs(built.pset, {
    borrowerNft: offer.opened.borrowerNft(),
    lenderNft: offer.opened.lenderNft(),
  })
  assertRepaymentOutputs(built.pset, offer, collateralReceiver)
  const { finalizedTx, summary } = built.finalize(borrower.signer.sign(built.pset))
  assertFinalizedWeights(finalizedTx, REPAYMENT_WEIGHTS)
  out(
    `finalized: repayment ${summary.repaymentOutpoint} (${summary.repayment} TEST units, ` +
      `interest ${summary.interest}), collateral to ${summary.collateralOutpoint}`,
  )
  return { hex: finalizedTx.toString(), txid: finalizedTx.txid().toString() }
}

async function repayStage(ctx: Context): Promise<void> {
  const { borrower } = ctx.wallets
  const acceptTxid = requireAcceptance()
  // the borrower NFT and the principal are back in the wallet
  requireConfirmed('claim-principal')
  const offer = await loadCreatedOffer(ctx, 'borrower')
  let hex: string | undefined
  let before: bigint | undefined
  if (!getRecord('repay')) {
    requireStageNeed(ctx, 'repay')
    before = confirmedBalance(borrower, TESTNET_ASSETS.principal)
    hex = (await buildSignedRepayment(ctx, offer, acceptTxid)).hex
  }
  const txid = await submitStage(
    ctx.chain,
    'repay',
    () => {
      if (hex === undefined) throw new Error('unreachable: a record exists')
      return hex
    },
    out,
  )

  const repayTx = await ctx.chain.fetchTx(txid)
  const repaymentAuth = repayTx.outputs[REPAYMENT_OUTPUT.repayment]
  if (
    !burnsNftOnChain(repayTx, REPAYMENT_OUTPUT.borrowerNftBurn, offer.opened.borrowerNft()) ||
    repaymentAuth === undefined ||
    repaymentAuth.scriptPubkey().jet_sha256_hex() !== offer.scripts.repaymentOutputScriptHash
  ) {
    throw new Error(
      'the confirmed repayment does not burn the borrower NFT and pay the repayment asset_auth',
    )
  }
  out(`borrower NFT burned at ${txid}:${REPAYMENT_OUTPUT.borrowerNftBurn}`)

  const collateralOutpoint = `${txid}:${REPAYMENT_OUTPUT.collateral}`
  const coin = await waitForWalletCoin(borrower, collateralOutpoint)
  const secrets = coin.unblinded()
  if (
    secrets.asset().toString() !== offer.opened.collateralAsset() ||
    secrets.value() !== offer.opened.collateralAmount()
  ) {
    throw new Error(
      `${collateralOutpoint} holds ${secrets.value()} of ${secrets.asset().toString()}`,
    )
  }
  out(
    `the borrower's collateral came back to its wallet: ${collateralOutpoint}, ` +
      `${secrets.value()} tL-sats`,
  )
  const after = confirmedBalance(borrower, TESTNET_ASSETS.principal)
  if (before !== undefined) {
    out(`borrower TEST (confirmed): ${before} -> ${after}`)
    if (before - after !== offer.opened.repaymentAmount()) {
      throw new Error(`the borrower's TEST balance fell by ${before - after}, not the repayment`)
    }
  } else {
    out(`borrower TEST (confirmed): ${after}`)
  }
  await assertWitnessWeights(ctx, txid, REPAYMENT_WEIGHTS)
  out('\nrepay: ok')
}

/** A repayment built, checked, signed and finalized, but never saved or broadcast. */
async function repayDryStage(ctx: Context): Promise<void> {
  requireStageNeed(ctx, 'repay')
  requireConfirmed('claim-principal')
  const offer = await loadCreatedOffer(ctx, 'borrower')
  const { txid } = await buildSignedRepayment(ctx, offer, requireAcceptance())
  out(`\nrepay-dry: ok (${txid} finalized, not saved or broadcast)`)
}

/**
 * The stage's own checks of a blinded repayment claim PSET: the lender NFT burned, and the
 * repayment to the lender's wallet, blinded to it.
 */
function assertRepaymentClaimOutputs(
  pset: lwk.Pset,
  offer: VerifiedOffer,
  receiver: lwk.Address,
): void {
  const opened = offer.opened
  const outputs = inspectPset(wasm, pset.toString()).outputs
  const repayment = outputs[REPAYMENT_CLAIM_OUTPUT.repayment]
  const checks: [string, boolean][] = [
    [
      'output 0 burns the lender NFT, explicit',
      burnsNft(outputs[REPAYMENT_CLAIM_OUTPUT.lenderNftBurn], opened.lenderNft()),
    ],
    [
      'output 1 is the repayment to the lender, blinded',
      repayment !== undefined &&
        repayment.script === receiver.scriptPubkey().toString() &&
        repayment.asset === opened.principalAsset() &&
        repayment.amount === opened.repaymentAmount() &&
        repayment.blindingKey !== null &&
        repayment.assetCommitment !== null &&
        repayment.amountCommitment !== null &&
        repayment.ecdhPubkey !== null,
    ],
  ]
  for (const [what, ok] of checks) {
    if (!ok) throw new Error(`repayment claim PSET: not true that ${what}`)
    out(`  ok: ${what}`)
  }
}

/** The repayment claim's inputs that LWK sized with a max-weight-to-satisfy constant. */
const REPAYMENT_CLAIM_WEIGHTS: WeightedInput[] = [
  {
    index: REPAYMENT_CLAIM_INPUT.repayment,
    name: 'repayment (asset_auth, burn)',
    limit: ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY,
  },
  {
    index: REPAYMENT_CLAIM_INPUT.lenderNft,
    name: 'lender NFT (p2wpkh)',
    limit: EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY,
  },
]

/**
 * The lender's claim of the repayment: built, checked by the stage, signed and finalized (which
 * runs the asset_auth). The lender NFT is still where the acceptance paid it.
 */
async function buildSignedRepaymentClaim(
  ctx: Context,
  offer: VerifiedOffer,
  acceptTxid: string,
  repayTxid: string,
): Promise<{ hex: string; txid: string }> {
  const { lender } = ctx.wallets
  const receiver = new lwk.Address(lender.address())
  const feeCoins = pickCoins(lender, TESTNET_ASSETS.policy, FEE_BUDGET, 'lender fee')
  out(`fee coins ${feeCoins.map(outpointOf).join(', ')}`)

  const built = await buildRepaymentClaim(flowDeps(lender, ctx.chain), offer, {
    repaymentOutpoint: `${repayTxid}:${REPAYMENT_OUTPUT.repayment}`,
    lenderNftOutpoint: `${acceptTxid}:${ACCEPTANCE_OUTPUT.lenderNft}`,
    feeCoins,
    receiver,
  })
  out('blinded repayment claim PSET:')
  describeOutputs(built.pset, {
    borrowerNft: offer.opened.borrowerNft(),
    lenderNft: offer.opened.lenderNft(),
  })
  assertRepaymentClaimOutputs(built.pset, offer, receiver)
  const { finalizedTx, summary } = built.finalize(lender.signer.sign(built.pset))
  assertFinalizedWeights(finalizedTx, REPAYMENT_CLAIM_WEIGHTS)
  out(`finalized: repayment to ${summary.repaymentOutpoint}`)
  return { hex: finalizedTx.toString(), txid: finalizedTx.txid().toString() }
}

async function claimRepaymentStage(ctx: Context): Promise<void> {
  const { lender } = ctx.wallets
  const acceptTxid = requireAcceptance()
  const repayTxid = requireConfirmed('repay')
  const offer = await loadCreatedOffer(ctx, 'lender')
  let hex: string | undefined
  let before: bigint | undefined
  if (!getRecord('claim-repayment')) {
    requireStageNeed(ctx, 'claim-repayment')
    before = confirmedBalance(lender, TESTNET_ASSETS.principal)
    hex = (await buildSignedRepaymentClaim(ctx, offer, acceptTxid, repayTxid)).hex
  }
  const txid = await submitStage(
    ctx.chain,
    'claim-repayment',
    () => {
      if (hex === undefined) throw new Error('unreachable: a record exists')
      return hex
    },
    out,
  )

  const claimTx = await ctx.chain.fetchTx(txid)
  if (!burnsNftOnChain(claimTx, REPAYMENT_CLAIM_OUTPUT.lenderNftBurn, offer.opened.lenderNft())) {
    throw new Error('the confirmed repayment claim does not burn the lender NFT')
  }
  out(`lender NFT burned at ${txid}:${REPAYMENT_CLAIM_OUTPUT.lenderNftBurn}`)

  const claimed = `${txid}:${REPAYMENT_CLAIM_OUTPUT.repayment}`
  const coin = await waitForWalletCoin(lender, claimed)
  const secrets = coin.unblinded()
  if (
    secrets.asset().toString() !== offer.opened.principalAsset() ||
    secrets.value() !== offer.opened.repaymentAmount()
  ) {
    throw new Error(`${claimed} holds ${secrets.value()} of ${secrets.asset().toString()}`)
  }
  out(`the lender's wallet received ${claimed}, ${secrets.value()} TEST units`)
  const after = confirmedBalance(lender, TESTNET_ASSETS.principal)
  if (before !== undefined) {
    out(`lender TEST (confirmed): ${before} -> ${after}`)
    if (after - before !== offer.opened.repaymentAmount()) {
      throw new Error(`the lender's TEST balance rose by ${after - before}, not the repayment`)
    }
  } else {
    out(`lender TEST (confirmed): ${after}`)
  }
  await assertWitnessWeights(ctx, txid, REPAYMENT_CLAIM_WEIGHTS)
  out('\nclaim-repayment: ok')
}

/** A repayment claim built, checked, signed and finalized, but never saved or broadcast. */
async function claimRepaymentDryStage(ctx: Context): Promise<void> {
  requireStageNeed(ctx, 'claim-repayment')
  const offer = await loadCreatedOffer(ctx, 'lender')
  const { txid } = await buildSignedRepaymentClaim(
    ctx,
    offer,
    requireAcceptance(),
    requireConfirmed('repay'),
  )
  out(`\nclaim-repayment-dry: ok (${txid} finalized, not saved or broadcast)`)
}

/** Whether an inspected output pays `amount` of `asset` to `receiver`, blinded to it. */
function paysBlinded(
  output: InspectedOutput | undefined,
  receiver: lwk.Address,
  asset: string,
  amount: bigint,
): boolean {
  return (
    output !== undefined &&
    output.script === receiver.scriptPubkey().toString() &&
    output.asset === asset &&
    output.amount === amount &&
    output.blindingKey !== null &&
    output.assetCommitment !== null &&
    output.amountCommitment !== null &&
    output.ecdhPubkey !== null
  )
}

/**
 * Checks that the wallet received the collateral at `outpoint`, and on the build path (`before`
 * set) that its confirmed tL-BTC moved by exactly the collateral less the transaction's fee: the
 * collateral is tL-BTC, the fee asset, and the wallet paid only the fee.
 */
async function assertCollateralReceived(
  wallet: SeedWallet,
  name: Wallet,
  tx: lwk.Transaction,
  outpoint: string,
  offer: VerifiedOffer,
  before: bigint | undefined,
): Promise<void> {
  const opened = offer.opened
  const secrets = (await waitForWalletCoin(wallet, outpoint)).unblinded()
  if (
    secrets.asset().toString() !== opened.collateralAsset() ||
    secrets.value() !== opened.collateralAmount()
  ) {
    throw new Error(`${outpoint} holds ${secrets.value()} of ${secrets.asset().toString()}`)
  }
  out(`the ${name}'s wallet received the collateral: ${outpoint}, ${secrets.value()} tL-sats`)
  const after = confirmedBalance(wallet, TESTNET_ASSETS.policy)
  if (before === undefined) {
    out(`${name} tL-BTC (confirmed): ${after}`)
    return
  }
  const fee = tx.fee(lwk.AssetId.fromString(TESTNET_ASSETS.policy))
  out(
    `${name} tL-BTC (confirmed): ${before} -> ${after} (+ collateral ${secrets.value()} - fee ${fee})`,
  )
  if (after - before !== secrets.value() - fee) {
    throw new Error(
      `the ${name}'s tL-BTC moved by ${after - before}, not the collateral less the fee`,
    )
  }
}

/**
 * The stage's own checks of a blinded cancellation PSET: both NFTs burned, and the collateral back
 * to the borrower, blinded to its wallet.
 */
function assertCancellationOutputs(
  pset: lwk.Pset,
  offer: VerifiedOffer,
  collateralReceiver: lwk.Address,
): void {
  const opened = offer.opened
  const outputs = inspectPset(wasm, pset.toString()).outputs
  const checks: [string, boolean][] = [
    [
      'output 0 burns the lender NFT, explicit',
      burnsNft(outputs[CANCELLATION_OUTPUT.lenderNftBurn], opened.lenderNft()),
    ],
    [
      'output 1 burns the borrower NFT, explicit',
      burnsNft(outputs[CANCELLATION_OUTPUT.borrowerNftBurn], opened.borrowerNft()),
    ],
    [
      'output 2 is the collateral back to the borrower, blinded',
      paysBlinded(
        outputs[CANCELLATION_OUTPUT.collateral],
        collateralReceiver,
        opened.collateralAsset(),
        opened.collateralAmount(),
      ),
    ],
  ]
  for (const [what, ok] of checks) {
    if (!ok) throw new Error(`cancellation PSET: not true that ${what}`)
    out(`  ok: ${what}`)
  }
}

/** The cancellation's inputs that LWK sized with a max-weight-to-satisfy constant. */
const CANCELLATION_WEIGHTS: WeightedInput[] = [
  {
    index: CANCELLATION_INPUT.offer,
    name: 'offer (OfferCancellation)',
    limit: PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.OfferCancellation,
  },
  {
    index: CANCELLATION_INPUT.lenderNft,
    name: 'lender NFT lock (script_auth)',
    limit: SCRIPT_AUTH_MAX_WEIGHT_TO_SATISFY,
  },
  {
    index: CANCELLATION_INPUT.borrowerNft,
    name: 'borrower NFT (p2wpkh)',
    limit: EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY,
  },
]

/**
 * The borrower's cancellation of the `cancel` offer: built, checked by the stage, signed and
 * finalized (which runs the covenants). The borrower NFT is still where the creation paid it.
 */
async function buildSignedCancellation(
  ctx: Context,
  offer: VerifiedOffer,
  creationTxid: string,
): Promise<{ hex: string; txid: string }> {
  const { borrower } = ctx.wallets
  const collateralReceiver = new lwk.Address(borrower.address())
  const feeCoins = pickCoins(borrower, TESTNET_ASSETS.policy, FEE_BUDGET, 'borrower fee')
  out(`fee coins ${feeCoins.map(outpointOf).join(', ')}`)

  const built = await buildPrivateCancellation(flowDeps(borrower, ctx.chain), offer, {
    borrowerNftOutpoint: `${creationTxid}:${CREATION_OUTPUT.borrowerNft}`,
    feeCoins,
    collateralReceiver,
  })
  out('blinded cancellation PSET:')
  describeOutputs(built.pset, {
    borrowerNft: offer.opened.borrowerNft(),
    lenderNft: offer.opened.lenderNft(),
  })
  assertCancellationOutputs(built.pset, offer, collateralReceiver)
  const { finalizedTx, summary } = built.finalize(borrower.signer.sign(built.pset))
  assertFinalizedWeights(finalizedTx, CANCELLATION_WEIGHTS)
  out(`finalized: collateral back to ${summary.collateralOutpoint} (${summary.collateral} tL-sats)`)
  return { hex: finalizedTx.toString(), txid: finalizedTx.txid().toString() }
}

/** A new offer from the borrower to the lender, which the borrower then cancels. */
async function cancelStage(ctx: Context): Promise<void> {
  const { borrower } = ctx.wallets
  const creationTxid = await submitCreation(
    ctx,
    'cancel-create',
    'cancel-create',
    OFFER_EXPIRY_BLOCKS,
  )
  await lenderView(ctx, creationTxid)
  const offer = await loadOffer(ctx, 'cancel-create', 'borrower')

  let hex: string | undefined
  let before: bigint | undefined
  if (!getRecord('cancel')) {
    requireStageNeed(ctx, 'cancel')
    before = confirmedBalance(borrower, TESTNET_ASSETS.policy)
    hex = (await buildSignedCancellation(ctx, offer, creationTxid)).hex
  }
  const txid = await submitStage(
    ctx.chain,
    'cancel',
    () => {
      if (hex === undefined) throw new Error('unreachable: a record exists')
      return hex
    },
    out,
  )

  const cancelTx = await ctx.chain.fetchTx(txid)
  if (
    !burnsNftOnChain(cancelTx, CANCELLATION_OUTPUT.lenderNftBurn, offer.opened.lenderNft()) ||
    !burnsNftOnChain(cancelTx, CANCELLATION_OUTPUT.borrowerNftBurn, offer.opened.borrowerNft())
  ) {
    throw new Error('the confirmed cancellation does not burn both NFTs')
  }
  out(
    `lender NFT burned at ${txid}:${CANCELLATION_OUTPUT.lenderNftBurn}, ` +
      `borrower NFT at ${txid}:${CANCELLATION_OUTPUT.borrowerNftBurn}`,
  )
  await assertCollateralReceived(
    borrower,
    'borrower',
    cancelTx,
    `${txid}:${CANCELLATION_OUTPUT.collateral}`,
    offer,
    before,
  )
  await assertWitnessWeights(ctx, txid, CANCELLATION_WEIGHTS)
  out('\ncancel: ok')
}

/** A cancellation built, checked, signed and finalized, but never saved or broadcast. */
async function cancelDryStage(ctx: Context): Promise<void> {
  requireStageNeed(ctx, 'cancel')
  const creationTxid = requireConfirmed('cancel-create')
  const offer = await loadOffer(ctx, 'cancel-create', 'borrower')
  const { txid } = await buildSignedCancellation(ctx, offer, creationTxid)
  out(`\ncancel-dry: ok (${txid} finalized, not saved or broadcast)`)
}

/** Blocks from the tip to the `liquidate` offer's loan expiration. */
const LIQUIDATION_EXPIRY_BLOCKS = 3

/** nSequence that enables the lock time without signalling RBF, from LWK, not the builders. */
function enableLocktimeNoRbf(): number {
  return lwk.TxSequence.enableLocktimeNoRbf().toConsensusU32()
}

/**
 * The stage's own checks of a blinded liquidation PSET: the lender NFT burned, the collateral to
 * the lender, blinded to its wallet, and the expiry as the lock time, enabled by the offer input.
 */
function assertLiquidationOutputs(
  pset: lwk.Pset,
  offer: VerifiedOffer,
  collateralReceiver: lwk.Address,
): void {
  const opened = offer.opened
  const expiry = opened.loanExpirationTime()
  const { lockTime, inputs, outputs } = inspectPset(wasm, pset.toString())
  const checks: [string, boolean][] = [
    [
      'output 0 burns the lender NFT, explicit',
      burnsNft(outputs[LIQUIDATION_OUTPUT.lenderNftBurn], opened.lenderNft()),
    ],
    [
      'output 1 is the collateral to the lender, blinded',
      paysBlinded(
        outputs[LIQUIDATION_OUTPUT.collateral],
        collateralReceiver,
        opened.collateralAsset(),
        opened.collateralAmount(),
      ),
    ],
    [`the lock time is the expiry, block ${expiry}`, lockTime === expiry],
    [
      `input 0, the offer, has sequence 0x${enableLocktimeNoRbf().toString(16)}, which enables it`,
      inputs[LIQUIDATION_INPUT.offer]?.sequence === enableLocktimeNoRbf(),
    ],
  ]
  for (const [what, ok] of checks) {
    if (!ok) throw new Error(`liquidation PSET: not true that ${what}`)
    out(`  ok: ${what}`)
  }
}

/** The liquidation's inputs that LWK sized with a max-weight-to-satisfy constant. */
const LIQUIDATION_WEIGHTS: WeightedInput[] = [
  {
    index: LIQUIDATION_INPUT.offer,
    name: 'offer (Liquidation)',
    limit: PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.Liquidation,
  },
  {
    index: LIQUIDATION_INPUT.lenderNft,
    name: 'lender NFT (p2wpkh)',
    limit: EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY,
  },
]

/** The lender's liquidation of the offer accepted by `acceptTxid`, at `tipHeight`. */
function liquidationParams(ctx: Context, acceptTxid: string, tipHeight: number): LiquidationParams {
  const { lender } = ctx.wallets
  return {
    activeOfferOutpoint: `${acceptTxid}:${ACCEPTANCE_OUTPUT.activeOffer}`,
    lenderNftOutpoint: `${acceptTxid}:${ACCEPTANCE_OUTPUT.lenderNft}`,
    feeCoins: pickCoins(lender, TESTNET_ASSETS.policy, FEE_BUDGET, 'lender fee'),
    collateralReceiver: new lwk.Address(lender.address()),
    tipHeight,
  }
}

/**
 * Tries the liquidation at the current tip. Below the expiry the builder must refuse with
 * `expiry-not-reached` before it fetches a transaction or starts a PSET. Returns whether the tip
 * was below the expiry, so that the refusal was checked.
 */
async function tryEarlyLiquidation(
  ctx: Context,
  offer: VerifiedOffer,
  acceptTxid: string,
): Promise<boolean> {
  const expiry = offer.opened.loanExpirationTime()
  const tip = await ctx.chain.tipHeight()
  if (tip >= expiry) {
    out(`early liquidation: not tried, the tip ${tip} has reached the expiry ${expiry}`)
    return false
  }
  // what the builder touches before it refuses: nothing
  const touched: string[] = []
  const base = flowDeps(ctx.wallets.lender, ctx.chain)
  const deps: PrivateFlowDeps = {
    ...base,
    lwk: {
      ...lwk,
      TxBuilder: new Proxy(lwk.TxBuilder, {
        construct(target, args) {
          touched.push('new TxBuilder')
          return Reflect.construct(target, args) as object
        },
      }),
    },
    fetchTx: txid => {
      touched.push(`fetchTx ${txid}`)
      return base.fetchTx(txid)
    },
    walletUtxos: () => {
      touched.push('walletUtxos')
      return base.walletUtxos()
    },
  }
  try {
    await buildPrivateLiquidation(deps, offer, liquidationParams(ctx, acceptTxid, tip))
  } catch (error) {
    if (!(error instanceof ExpiryNotReachedError) || error.code !== 'expiry-not-reached') {
      throw error
    }
    if (touched.length > 0) throw new Error(`the refused liquidation did ${touched.join(', ')}`)
    out(
      `early liquidation at tip ${tip}, below the expiry ${expiry}: refused, nothing fetched or built`,
    )
    out(`  ${error.message}`)
    return true
  }
  throw new Error(`the liquidation was built at tip ${tip}, below the expiry ${expiry}`)
}

/**
 * The lender's liquidation of the `liquidate` offer, at a tip at or past the expiry: built, checked
 * by the stage, signed and finalized (which runs the covenant and its lock height check).
 */
async function buildSignedLiquidation(
  ctx: Context,
  offer: VerifiedOffer,
  acceptTxid: string,
  tipHeight: number,
): Promise<{ hex: string; txid: string }> {
  const { lender } = ctx.wallets
  const params = liquidationParams(ctx, acceptTxid, tipHeight)
  out(`fee coins ${params.feeCoins.map(outpointOf).join(', ')}`)

  const built = await buildPrivateLiquidation(flowDeps(lender, ctx.chain), offer, params)
  out('blinded liquidation PSET:')
  describeOutputs(built.pset, {
    borrowerNft: offer.opened.borrowerNft(),
    lenderNft: offer.opened.lenderNft(),
  })
  assertLiquidationOutputs(built.pset, offer, params.collateralReceiver)
  const { finalizedTx, summary } = built.finalize(lender.signer.sign(built.pset))
  assertFinalizedWeights(finalizedTx, LIQUIDATION_WEIGHTS)
  out(
    `finalized: collateral to ${summary.collateralOutpoint} (${summary.collateral} tL-sats), ` +
      `lock time ${summary.lockTime}`,
  )
  return { hex: finalizedTx.toString(), txid: finalizedTx.txid().toString() }
}

/**
 * A new offer from the borrower to the lender that expires three blocks after the tip. The lender
 * accepts it; a liquidation is refused while the tip is below the expiry (tried once the
 * acceptance is broadcast, and again once it confirmed), then the lender liquidates at the expiry.
 */
async function liquidateStage(ctx: Context): Promise<void> {
  const { lender } = ctx.wallets
  const creationTxid = await submitCreation(
    ctx,
    'liquidate-create',
    'liquidate-create',
    LIQUIDATION_EXPIRY_BLOCKS,
  )
  await lenderView(ctx, creationTxid)
  const offer = await loadOffer(ctx, 'liquidate-create', 'lender')
  const expiry = offer.opened.loanExpirationTime()

  let refusals = 0
  const tryEarly = async (acceptTxid: string): Promise<void> => {
    if (await tryEarlyLiquidation(ctx, offer, acceptTxid)) refusals += 1
  }
  const acceptedNow = getRecord('liquidate-accept') === undefined
  const acceptTxid = await submitAcceptance(ctx, 'liquidate-accept', offer, tryEarly)

  let hex: string | undefined
  let before: bigint | undefined
  if (!getRecord('liquidate')) {
    await tryEarly(acceptTxid)
    if (refusals === 0) {
      // a run that accepted the offer had the whole window below the expiry
      if (acceptedNow) throw new Error('the liquidation was never tried below the expiry')
      out('early liquidation: not tried in this run, which resumed at or past the expiry')
    }
    out(`waiting for the tip to reach the expiry, block ${expiry}`)
    const tip = await ctx.chain.waitForTip(expiry)
    out(`tip ${tip}`)
    requireStageNeed(ctx, 'liquidate')
    before = confirmedBalance(lender, TESTNET_ASSETS.policy)
    hex = (await buildSignedLiquidation(ctx, offer, acceptTxid, tip)).hex
  }
  const txid = await submitStage(
    ctx.chain,
    'liquidate',
    () => {
      if (hex === undefined) throw new Error('unreachable: a record exists')
      return hex
    },
    out,
  )

  const liquidationTx = await ctx.chain.fetchTx(txid)
  if (!burnsNftOnChain(liquidationTx, LIQUIDATION_OUTPUT.lenderNftBurn, offer.opened.lenderNft())) {
    throw new Error('the confirmed liquidation does not burn the lender NFT')
  }
  out(`lender NFT burned at ${txid}:${LIQUIDATION_OUTPUT.lenderNftBurn}`)
  const timelock = await ctx.chain.fetchTimelock(txid)
  const sequence = timelock.sequences[LIQUIDATION_INPUT.offer]
  if (
    timelock.lockTime !== expiry ||
    sequence !== enableLocktimeNoRbf() ||
    timelock.blockHeight === null ||
    timelock.blockHeight <= expiry
  ) {
    throw new Error(
      `the confirmed liquidation has lock time ${timelock.lockTime}, offer input sequence ` +
        `${sequence} and block ${timelock.blockHeight}; expected the expiry ${expiry}, ` +
        `${enableLocktimeNoRbf()} and a block after the expiry`,
    )
  }
  out(
    `lock time ${timelock.lockTime} (the expiry), offer input sequence 0x${sequence.toString(16)}, ` +
      `mined in block ${timelock.blockHeight}, after the expiry`,
  )
  await assertCollateralReceived(
    lender,
    'lender',
    liquidationTx,
    `${txid}:${LIQUIDATION_OUTPUT.collateral}`,
    offer,
    before,
  )
  await assertWitnessWeights(ctx, txid, LIQUIDATION_WEIGHTS)
  out('\nliquidate: ok')
}

/**
 * The liquidation of the `liquidate` offer at the current tip: below the expiry it must be
 * refused; past it, it is built, checked, signed and finalized, but never saved or broadcast.
 */
async function liquidateDryStage(ctx: Context): Promise<void> {
  requireStageNeed(ctx, 'liquidate')
  const acceptTxid = requireConfirmed('liquidate-accept')
  const offer = await loadOffer(ctx, 'liquidate-create', 'lender')
  if (await tryEarlyLiquidation(ctx, offer, acceptTxid)) {
    out('\nliquidate-dry: ok (refused below the expiry, nothing built)')
    return
  }
  const tip = await ctx.chain.tipHeight()
  const { txid } = await buildSignedLiquidation(ctx, offer, acceptTxid, tip)
  out(`\nliquidate-dry: ok (${txid} finalized at tip ${tip}, not saved or broadcast)`)
}

/** An e2e offer, which the borrower created for the lender. */
interface Creation {
  stage: CreationRecord
  txid: string
}

/** The candidate-list requests among `requests`, with their height bounds. */
function candidatePages(requests: URL[]): { from: string | null; to: string | null }[] {
  return requests
    .filter(url => url.pathname === '/private/candidates')
    .map(url => ({
      from: url.searchParams.get('from_height'),
      to: url.searchParams.get('to_height'),
    }))
}

/** The creation txids whose transaction `requests` fetched. */
function fetchedTxs(requests: URL[]): string[] {
  return requests.flatMap(url => {
    const match = /^\/private\/candidates\/([0-9a-f]{64})\/tx$/.exec(url.pathname)
    return match ? [match[1]] : []
  })
}

/** Every candidate the indexer lists, and its sync height, paged as the README's sync recipe. */
async function listCandidates(
  apiUrl: string,
): Promise<{ candidates: PrivateCandidate[]; lastIndexed: number | null }> {
  const first = await fetchPrivateCandidates({ fromHeight: 0, limit: 500 }, apiUrl)
  const lastIndexed = first.last_indexed_height
  if (lastIndexed === null) return { candidates: [], lastIndexed }
  const candidates = [...first.items]
  for (let page = first; page.items.length > 0; ) {
    page = await fetchPrivateCandidates(
      { fromHeight: 0, toHeight: lastIndexed, limit: 500, offset: candidates.length },
      apiUrl,
    )
    candidates.push(...page.items)
  }
  return { candidates, lastIndexed }
}

/** Whether `candidate` passes the lender's view tag or the borrower's own-nonce check. */
function cheapMatch(key: wasm.LendingKey, candidate: PrivateCandidate): boolean {
  const { txid, vout } = candidate.first_input
  return (
    wasm.viewTagMatches(key, candidate.nonce, candidate.view_tag) ||
    wasm.isOwnCandidate(
      key,
      `${txid}:${vout}`,
      candidate.borrower_nft_asset_id,
      candidate.lender_nft_asset_id,
      candidate.nonce,
    )
  )
}

function describeResult(result: ScanResult | undefined): string {
  if (result === undefined) return 'absent'
  return result.result === 'verified'
    ? `verified (${result.role})`
    : `invalid: ${result.code} (${result.role})`
}

/** Throws unless `state` holds exactly the e2e offers, each verified as `role`. */
function assertScanOffers(
  state: ScanState,
  creations: Creation[],
  role: Wallet,
  what: string,
): void {
  const expected = creations.map(creation => creation.txid).sort()
  const found = Object.keys(state.offers).sort()
  if (!isDeepStrictEqual(found, expected)) {
    throw new Error(
      `${what} found ${found.join(', ') || 'nothing'}; expected the e2e offers ${expected.join(', ')}`,
    )
  }
  for (const creation of creations) {
    const result = state.offers[creation.txid]
    if (result.result !== 'verified' || result.role !== role) {
      throw new Error(
        `${what}: ${creation.stage} is ${describeResult(result)}, not verified as ${role}`,
      )
    }
  }
}

/**
 * One wallet's scan through the proxy: a first sync from an empty store, which must follow the
 * sync recipe, fetch only the transactions of candidates that pass a cheap check, and find
 * exactly the e2e offers; then a re-sync from the stored state, which must start right after the
 * stored height and keep the same offers.
 */
async function scanAs(
  ctx: Context,
  proxy: IndexerProxy,
  name: Wallet,
  creations: Creation[],
  candidateCount: number,
): Promise<void> {
  const wallet = ctx.wallets[name]
  const deps = flowDeps(wallet, ctx.chain)
  const key = wallet.lendingKey
  const store = memoryScanStore()
  out(`${name} (${fingerprintGroups(key.fingerprint())})`)

  proxy.requests.length = 0
  const first = await syncOffers(deps, key, proxy.url, store)
  const firstRequests = proxy.requests.splice(0)
  assertScanOffers(first, creations, name, `${name}'s first sync`)
  const synced = first.syncedHeight
  if (synced === null) throw new Error(`${name}'s first sync left no synced height`)
  const pages = candidatePages(firstRequests)
  const recipe =
    pages.length >= 2 &&
    pages[0].from === '0' &&
    pages[0].to === null &&
    pages.slice(1).every(page => page.from === '0' && page.to === String(synced))
  if (!recipe) {
    throw new Error(
      `${name}'s first sync paged ${JSON.stringify(pages)}; expected from 0, then to ${synced}`,
    )
  }
  const fetched = fetchedTxs(firstRequests)
  for (const txid of fetched) {
    if (!cheapMatch(key, await fetchPrivateCandidate(txid, ctx.apiUrl))) {
      throw new Error(`${name} fetched ${txid}'s transaction, but its candidate passes no check`)
    }
  }
  if (!isDeepStrictEqual(await store.get(key.fingerprint()), first)) {
    throw new Error(`${name}'s store does not hold the state its first sync returned`)
  }
  out(
    `  first sync: from block 0 to ${synced} in ${pages.length} pages; fetched the ` +
      `transaction of ${fetched.length} of ${candidateCount} candidates`,
  )
  for (const creation of creations) {
    out(
      `    ${creation.stage.padEnd(16)} ${creation.txid} ${describeResult(first.offers[creation.txid])}`,
    )
  }

  const second = await syncOffers(deps, key, proxy.url, store)
  const secondRequests = proxy.requests.splice(0)
  const resync = candidatePages(secondRequests)
  if (resync[0]?.from !== String(synced + 1)) {
    throw new Error(`${name}'s re-sync started at ${resync[0]?.from}, not block ${synced + 1}`)
  }
  if (!isDeepStrictEqual(second.offers, first.offers)) {
    throw new Error(`${name}'s re-sync changed the offers: ${JSON.stringify(second.offers)}`)
  }
  if (second.syncedHeight === null || second.syncedHeight < synced) {
    throw new Error(`${name}'s re-sync moved the synced height back to ${second.syncedHeight}`)
  }
  const refetched = fetchedTxs(secondRequests).filter(txid =>
    creations.some(creation => creation.txid === txid),
  )
  if (refetched.length > 0) {
    throw new Error(`${name}'s re-sync fetched ${refetched.join(', ')} again`)
  }
  out(
    `  re-sync: from block ${synced + 1} in ${resync.length} pages, now synced to ` +
      `${second.syncedHeight}; the same ${Object.keys(second.offers).length} offers, no known ` +
      'transaction fetched',
  )

  const [loaded] = creations
  const offer = await loadVerifiedOffer(deps, key, loaded.txid, name, ctx.apiUrl)
  if (
    offer.role !== name ||
    offer.creationTx.txid().toString() !== loaded.txid ||
    offer.opened.principalAmount() !== PRINCIPAL ||
    offer.opened.repaymentAmount() !== REPAYMENT
  ) {
    throw new Error(`${name}: loadVerifiedOffer(${loaded.stage}) returned another offer`)
  }
  out(
    `  loadVerifiedOffer(${loaded.stage}): principal ${offer.opened.principalAmount()}, ` +
      `repayment ${offer.opened.repaymentAmount()} TEST units`,
  )
}

/**
 * A fresh random key, which no offer is addressed to: its scan must find nothing, and fetch the
 * transaction only of candidates that pass a cheap check (one in 256 passes the view tag).
 */
async function strangerScan(
  ctx: Context,
  proxy: IndexerProxy,
  candidateCount: number,
): Promise<void> {
  const key = wasm.LendingKey.fromMasterBlindingKey(randomBytes(32).toString('hex'))
  // The deps only lend the wasm, LWK, sources and network; no wallet coin is used.
  const deps = flowDeps(ctx.wallets.lender, ctx.chain)
  proxy.requests.length = 0
  const state = await syncOffers(deps, key, proxy.url, memoryScanStore())
  const fetched = fetchedTxs(proxy.requests.splice(0))
  if (Object.keys(state.offers).length > 0) {
    throw new Error(`a fresh key found offers: ${JSON.stringify(state.offers)}`)
  }
  for (const txid of fetched) {
    if (!cheapMatch(key, await fetchPrivateCandidate(txid, ctx.apiUrl))) {
      throw new Error(
        `a fresh key fetched ${txid}'s transaction, but its candidate passes no check`,
      )
    }
  }
  out(
    `stranger (${fingerprintGroups(key.fingerprint())}): no offers; fetched the transaction of ` +
      `${fetched.length} of ${candidateCount} candidates`,
  )
}

/**
 * A hostile indexer serves the first e2e offer's candidate with the second's creation
 * transaction, which is addressed to the same keys. The first offer must come out invalid
 * (`creation-tx-mismatch`), never verified, and `loadVerifiedOffer` must refuse it. That result
 * says nothing final about the offer, so the next sync, against the honest indexer, checks it
 * again by txid and must find it verified.
 */
async function hostileScan(
  ctx: Context,
  proxy: IndexerProxy,
  creations: Creation[],
): Promise<void> {
  const [victim, served, ...rest] = creations
  const others = [served, ...rest]
  out(`hostile indexer: ${victim.stage}'s candidate comes with ${served.stage}'s transaction`)
  try {
    for (const name of NAMES) {
      const wallet = ctx.wallets[name]
      const deps = flowDeps(wallet, ctx.chain)
      const store = memoryScanStore()
      proxy.substitute = { candidate: victim.txid, servedTx: served.txid }
      const state = await syncOffers(deps, wallet.lendingKey, proxy.url, store)
      const result = state.offers[victim.txid]
      if (result?.result !== 'invalid' || result.code !== CREATION_TX_MISMATCH) {
        throw new Error(
          `${name}: with the hostile indexer, ${victim.stage} is ${describeResult(result)}, ` +
            `not invalid: ${CREATION_TX_MISMATCH}`,
        )
      }
      for (const other of others) {
        if (state.offers[other.txid]?.result !== 'verified') {
          throw new Error(`${name}: ${other.stage} is ${describeResult(state.offers[other.txid])}`)
        }
      }
      const refusal = await loadVerifiedOffer(
        deps,
        wallet.lendingKey,
        victim.txid,
        name,
        proxy.url,
      ).then(
        () => null,
        (error: unknown) => error,
      )
      if (!(refusal instanceof PrivateOfferError)) {
        if (refusal !== null) throw refusal
        throw new Error(
          `${name}: loadVerifiedOffer accepted ${victim.stage} from the hostile indexer`,
        )
      }
      out(
        `  ${name}: ${victim.stage} ${describeResult(result)}, the others verified; ` +
          `loadVerifiedOffer refuses it (${refusal.code})`,
      )

      proxy.substitute = null
      proxy.requests.length = 0
      const healed = await syncOffers(deps, wallet.lendingKey, proxy.url, store)
      const refetched = fetchedTxs(proxy.requests.splice(0))
      const healedResult = healed.offers[victim.txid]
      if (healedResult?.result !== 'verified' || healedResult.role !== name) {
        throw new Error(
          `${name}: against the honest indexer, ${victim.stage} stays ` +
            describeResult(healedResult),
        )
      }
      if (
        !refetched.includes(victim.txid) ||
        others.some(other => refetched.includes(other.txid)) ||
        others.some(other => healed.offers[other.txid]?.result !== 'verified')
      ) {
        throw new Error(
          `${name}: the honest re-sync fetched ${refetched.join(', ') || 'nothing'} and found ` +
            JSON.stringify(healed.offers),
        )
      }
      out(
        `  ${name}: the next sync, honest, checks ${victim.stage} again by txid: ` +
          `${describeResult(healedResult)}; the verified offers are not fetched again`,
      )
    }
  } finally {
    proxy.substitute = null
  }
}

/**
 * A cheap check that fails with anything but `bad-input` is a local fault (here a wrapper whose
 * `viewTagMatches` throws, as a broken wasm instance or a freed key would): the sync must reject
 * and leave the stored state as it was, never count it as "no match" and move the synced height
 * past offers it did not check. A `bad-input` from the same check is no match.
 */
async function localFaultScan(ctx: Context): Promise<void> {
  const { lender } = ctx.wallets
  const key = lender.lendingKey
  const withViewTagCheck = (viewTagMatches: () => boolean): PrivateFlowDeps => ({
    ...flowDeps(lender, ctx.chain),
    wasm: { ...wasm, viewTagMatches },
  })
  const fault = new Error('RuntimeError: unreachable (the e2e stand-in for a broken wasm)')
  const seeded: ScanState = { syncedHeight: 0, offers: {} }
  const store = memoryScanStore()
  await store.set(key.fingerprint(), seeded)
  const outcome = await syncOffers(
    withViewTagCheck(() => {
      throw fault
    }),
    key,
    ctx.apiUrl,
    store,
  ).then(
    () => null,
    (error: unknown) => error,
  )
  if (outcome !== fault) {
    throw new Error(`a local fault in the view-tag check did not fail the sync: ${String(outcome)}`)
  }
  if (!isDeepStrictEqual(await store.get(key.fingerprint()), seeded)) {
    throw new Error('the sync that failed on a local fault changed the stored state')
  }

  // The lender is the lender of every e2e offer: with no view tag, it finds none.
  const malformed = await syncOffers(
    withViewTagCheck(() => {
      throw 'bad-input: the e2e stand-in for a malformed nonce'
    }),
    key,
    ctx.apiUrl,
    memoryScanStore(),
  )
  if (Object.keys(malformed.offers).length > 0 || malformed.syncedHeight === null) {
    throw new Error(`a bad-input view-tag check gave ${JSON.stringify(malformed)}`)
  }
  out(
    'local fault: a view-tag check throwing a non-bad-input error fails the sync and leaves the ' +
      'stored state unchanged; a bad-input is no match',
  )
}

/** The lender registers in the directory, is listed, and removes its entry. */
async function directoryRoundTrip(ctx: Context): Promise<void> {
  const { lender } = ctx.wallets
  const deps = flowDeps(lender, ctx.chain)
  const key = lender.lendingKey
  const pubkey = key.xOnlyPublicKey()
  const name = 'E2E Lender'
  out(`directory: ${fingerprintGroups(key.fingerprint())}`)

  const entry = await registerInDirectory(deps, key, name, ctx.apiUrl)
  const fetched = await fetchDirectoryEntry(pubkey, ctx.apiUrl)
  for (const [what, got] of [
    ['PUT', entry],
    ['GET', fetched],
  ] as const) {
    if (got.pubkey !== pubkey || got.display_name !== name) {
      throw new Error(
        `directory ${what} returned ${JSON.stringify(got)}, not "${name}" for ${pubkey}`,
      )
    }
  }
  const listed = await fetchDirectory({ limit: 100 }, ctx.apiUrl)
  if (!listed.items.some(item => item.pubkey === pubkey && item.display_name === name)) {
    throw new Error('the directory list does not show the new entry')
  }
  out(`  registered "${fetched.display_name}"; GET and the list show it`)

  // a signature over another name: refused with 401 and the server's message
  const { challenge } = await requestDirectoryChallenge(ctx.apiUrl)
  const signature = wasm.signDirectoryAction(key, wasm.DirectoryAction.Put, challenge, name)
  const refusal = await putDirectoryEntry(
    pubkey,
    { display_name: 'E2E Impostor', challenge, signature },
    ctx.apiUrl,
  ).then(
    () => null,
    (error: unknown) => error,
  )
  if (
    !(refusal instanceof ApiError) ||
    refusal.status !== 401 ||
    indexerErrorMessage(refusal) !== 'invalid signature'
  ) {
    throw new Error(`a PUT signed over another name was not refused with 401: ${String(refusal)}`)
  }
  out(`  a PUT signed over another name: 401 "${indexerErrorMessage(refusal)}"`)

  await removeFromDirectory(deps, key, ctx.apiUrl)
  const gone = await fetchDirectoryEntry(pubkey, ctx.apiUrl).then(
    () => null,
    (error: unknown) => error,
  )
  if (!(gone instanceof ApiError) || gone.status !== 404) {
    throw new Error(`the entry is still there after the delete: ${String(gone)}`)
  }
  out('  removed; GET answers 404')
}

/**
 * Both wallets scan the local indexer (`web/README.md`, "Local testnet indexer") for the e2e
 * offers, a hostile indexer cannot get an offer verified, and the lender writes the directory.
 * Nothing is broadcast.
 */
async function scanStage(ctx: Context): Promise<void> {
  const creations: Creation[] = (Object.keys(CREATION_STAGES) as CreationRecord[]).map(stage => {
    const record = getRecord(stage)
    if (record?.status !== 'confirmed') {
      throw new Error(`no confirmed ${stage}: run the ${CREATION_STAGES[stage]} stage`)
    }
    return { stage, txid: record.txid }
  })
  const { candidates, lastIndexed } = await listCandidates(ctx.apiUrl)
  for (const creation of creations) {
    const { blockHeight } = await ctx.chain.fetchTimelock(creation.txid)
    if (blockHeight === null) throw new Error(`${creation.stage} ${creation.txid} is not confirmed`)
    if (lastIndexed === null || lastIndexed < blockHeight) {
      throw new Error(
        `the indexer at ${ctx.apiUrl} has indexed to block ${lastIndexed}, not yet ` +
          `${creation.stage}'s block ${blockHeight}: let it catch up`,
      )
    }
    if (!candidates.some(candidate => candidate.creation_txid === creation.txid)) {
      throw new Error(
        `the indexer does not list ${creation.stage} ${creation.txid} (block ${blockHeight}): ` +
          'start it below that block (INDEXER__LAST_INDEXED_HEIGHT, web/README.md)',
      )
    }
  }
  out(`indexer ${ctx.apiUrl}: ${candidates.length} candidates up to block ${lastIndexed}`)

  const proxy = await startIndexerProxy(ctx.apiUrl)
  try {
    for (const name of NAMES) await scanAs(ctx, proxy, name, creations, candidates.length)
    await strangerScan(ctx, proxy, candidates.length)
    await hostileScan(ctx, proxy, creations)
    await localFaultScan(ctx)
  } finally {
    await proxy.close()
  }
  await directoryRoundTrip(ctx)
  out('\nscan: ok')
}

const STAGES: Record<string, (ctx: Context) => Promise<void>> = {
  wallets: walletsStage,
  'create-dry': createDryStage,
  create: createStage,
  'accept-dry': acceptDryStage,
  accept: acceptStage,
  'claim-principal-dry': claimPrincipalDryStage,
  'claim-principal': claimPrincipalStage,
  'repay-dry': repayDryStage,
  repay: repayStage,
  'claim-repayment-dry': claimRepaymentDryStage,
  'claim-repayment': claimRepaymentStage,
  'cancel-dry': cancelDryStage,
  cancel: cancelStage,
  'liquidate-dry': liquidateDryStage,
  liquidate: liquidateStage,
  scan: scanStage,
}

/**
 * The stages run when none is named: the real ones. The dry ones (`*-dry`) only rebuild and check
 * a stage's transaction, from whatever coins the wallets hold now, so they run only by name.
 */
const DEFAULT_STAGES = Object.keys(STAGES).filter(name => !name.endsWith('-dry'))

async function main(): Promise<void> {
  const requested = process.argv.slice(2)
  const names = requested.length > 0 ? requested : DEFAULT_STAGES
  for (const name of names) {
    if (!STAGES[name]) {
      throw new Error(`unknown stage "${name}"; known: ${Object.keys(STAGES).join(', ')}`)
    }
  }
  await initRuntime()
  const env = loadEnv()
  const ctx: Context = {
    chain: createChain(env.esploraApi),
    wallets: {
      borrower: seedWallet(env, env.borrowerMnemonic),
      lender: seedWallet(env, env.lenderMnemonic),
    },
    apiUrl: env.apiUrl,
  }
  await ctx.wallets.borrower.sync()
  await ctx.wallets.lender.sync()
  requireFunding(ctx)
  for (const name of names) {
    out(`== ${name}`)
    await STAGES[name](ctx)
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
