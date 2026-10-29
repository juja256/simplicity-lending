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

import { buildPrivateAcceptance } from '@/privateLending/flows/acceptance'
import { buildPrincipalClaim } from '@/privateLending/flows/claimPrincipal'
import { buildPrivateCreation } from '@/privateLending/flows/creation'
import { outpointOf } from '@/privateLending/flows/shared'
import { type InspectedOutput, inspectPset } from '@/privateLending/inspectPset'
import { openAndVerifyOffer, type VerifiedOffer } from '@/privateLending/verify'
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
  const [borrowerNftOutput, lenderNftOutput, , offerOutput] = inspectPset(
    wasm,
    pset.toString(),
  ).outputs
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
  out(`  offer        ${txid}:3`)
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
  const [active, principal, lenderNft] = inspectPset(wasm, pset.toString()).outputs
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
        lenderNft.amount === 1n &&
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
  const [nft, principal] = inspectPset(wasm, pset.toString()).outputs
  const checks: [string, boolean][] = [
    [
      'output 0 is the borrower NFT to the borrower, explicit',
      nft !== undefined &&
        nft.script === receiver.toUnconfidential().scriptPubkey().toString() &&
        nft.asset === opened.borrowerNft() &&
        nft.amount === 1n &&
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

/** Prints the witness weight of each named input of a broadcast transaction. */
async function reportWitnessWeights(ctx: Context, txid: string, names: string[]): Promise<void> {
  const witnesses = await ctx.chain.fetchWitnesses(txid)
  out('witness weights (serialized script witness, WU):')
  names.forEach((name, index) => {
    const items = witnesses[index] ?? []
    const sizes = items.map(item => item.length / 2).join(' + ')
    out(`  input ${index} ${name.padEnd(28)} ${witnessWeight(items)} (items ${sizes})`)
  })
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
  const lenderNft = acceptanceTx.outputs[2]
  if (
    lenderNft?.asset()?.toString() !== offer.opened.lenderNft() ||
    lenderNft.value() !== 1n ||
    walletAddressIndex(ctx.wallets.lender, lenderNft.scriptPubkey().toString()) === undefined
  ) {
    throw new Error('the confirmed acceptance does not pay the lender NFT to the lender')
  }
  out(`lender NFT ${offer.opened.lenderNft()} at ${txid}:2 (a lender address)`)
  await reportWitnessWeights(ctx, txid, [
    'offer (OfferAcceptance)',
    'lender NFT lock (script_auth)',
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
  if (claim?.status === 'confirmed') return `${claim.txid}:0`
  const create = getRecord('create')
  if (!create) throw new Error('no offer: run the create stage')
  return `${create.txid}:0`
}

function requireAcceptance(): string {
  const accept = getRecord('accept')
  if (accept?.status !== 'confirmed') throw new Error('no confirmed acceptance: run accept')
  return accept.txid
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
    principalOutpoint: `${acceptTxid}:1`,
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

/** Syncs until the wallet lists `outpoint` as a confirmed coin. */
async function waitForWalletCoin(wallet: SeedWallet, outpoint: string): Promise<lwk.WalletTxOut> {
  for (let attempt = 0; ; attempt += 1) {
    await wallet.sync()
    const coin = wallet
      .utxos()
      .find(utxo => outpointOf(utxo) === outpoint && utxo.height() !== undefined)
    if (coin) return coin
    if (attempt >= 11) throw new Error(`the wallet does not list ${outpoint} as a confirmed coin`)
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

  const coin = await waitForWalletCoin(borrower, `${txid}:1`)
  const secrets = coin.unblinded()
  if (
    secrets.asset().toString() !== offer.opened.principalAsset() ||
    secrets.value() !== offer.opened.principalAmount()
  ) {
    throw new Error(`${txid}:1 holds ${secrets.value()} of ${secrets.asset().toString()}`)
  }
  out(`the borrower's wallet holds ${txid}:1, ${secrets.value()} TEST units`)
  const after = confirmedBalance(borrower, TESTNET_ASSETS.principal)
  if (before !== undefined) {
    out(`borrower TEST (confirmed): ${before} -> ${after}`)
    if (after - before !== offer.opened.principalAmount()) {
      throw new Error(`the borrower's TEST balance rose by ${after - before}, not the principal`)
    }
  } else {
    out(`borrower TEST (confirmed): ${after}`)
  }
  await reportWitnessWeights(ctx, txid, ['principal (asset_auth)', 'borrower NFT (p2wpkh)'])
  out('\nclaim-principal: ok')
}

/** A principal claim built, checked, signed and finalized, but never saved or broadcast. */
async function claimPrincipalDryStage(ctx: Context): Promise<void> {
  requireStageNeed(ctx, 'claim-principal')
  const offer = await loadCreatedOffer(ctx, 'borrower')
  const { txid } = await buildSignedClaim(ctx, offer, requireAcceptance())
  out(`\nclaim-principal-dry: ok (${txid} finalized, not saved or broadcast)`)
}

const STAGES: Record<string, (ctx: Context) => Promise<void>> = {
  wallets: walletsStage,
  'create-dry': createDryStage,
  create: createStage,
  'accept-dry': acceptDryStage,
  accept: acceptStage,
  'claim-principal-dry': claimPrincipalDryStage,
  'claim-principal': claimPrincipalStage,
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
