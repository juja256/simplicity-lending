// Testnet end-to-end run of the private lending flows.
//   npx pnpm@10.33.0 e2e:private [stage...]
// Stages run in the order given. Seed phrases come from `.env.e2e.local` and are never printed.
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
import * as lwk from '@lilbonekit/lwk-web'

import { EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY } from '@/lwk/weights'
import { buildPrivateAcceptance } from '@/privateLending/flows/acceptance'
import { buildPrincipalClaim } from '@/privateLending/flows/claimPrincipal'
import { buildRepaymentClaim } from '@/privateLending/flows/claimRepayment'
import { buildPrivateCreation } from '@/privateLending/flows/creation'
import { buildPrivateRepayment } from '@/privateLending/flows/repayment'
import { outpointOf } from '@/privateLending/flows/shared'
import { type InspectedOutput, inspectPset } from '@/privateLending/inspectPset'
import { openAndVerifyOffer, type VerifiedOffer } from '@/privateLending/verify'
import {
  ASSET_AUTH_BURN_MAX_WEIGHT_TO_SATISFY,
  ASSET_AUTH_MAX_WEIGHT_TO_SATISFY,
} from '@/simplicity/asset-auth/witness'
import {
  ACCEPTANCE_INPUT,
  ACCEPTANCE_OUTPUT,
  CREATION_OUTPUT,
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
import { getRecord } from './e2e/state'
import { fingerprintGroups, flowDeps, initRuntime, type SeedWallet, seedWallet } from './e2e/wallet'

interface Context {
  chain: ReturnType<typeof createChain>
  wallets: Record<Wallet, SeedWallet>
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
 * `broadcast` one still counts, as its coins are not spent until it confirms.
 */
function requireFunding(ctx: Context): void {
  const remaining = STAGE_NAMES.filter(stage => getRecord(stage)?.status !== 'confirmed')
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

/** The `create` offer, fetched from chain and opened through the gate as `role`. */
async function loadCreatedOffer(ctx: Context, role: Wallet): Promise<VerifiedOffer> {
  const record = getRecord('create')
  if (record?.status !== 'confirmed') throw new Error('no confirmed offer: run the create stage')
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

/**
 * The lender's acceptance of the `create` offer: built, checked by the stage, signed and
 * finalized (which runs the covenants). The caller saves and broadcasts it, or not.
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
  out(
    `finalized: active offer ${summary.activeOfferOutpoint}, principal ${summary.principalOutpoint}`,
  )
  return { hex: finalizedTx.toString(), txid: finalizedTx.txid().toString() }
}

async function acceptStage(ctx: Context): Promise<void> {
  const offer = await loadCreatedOffer(ctx, 'lender')
  let hex: string | undefined
  if (!getRecord('accept')) {
    requireStageNeed(ctx, 'accept')
    hex = (await buildSignedAcceptance(ctx, offer)).hex
  }
  const txid = await submitStage(
    ctx.chain,
    'accept',
    () => {
      if (hex === undefined) throw new Error('unreachable: a record exists')
      return hex
    },
    out,
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
  await assertWitnessWeights(ctx, txid, [
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
  ])
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
