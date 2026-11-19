// Proves that the browser (LWK + the private-lending wasm) derives the same offer addresses
// as the Rust code. Run it with `pnpm parity`; it must pass before browser addresses are relied on.
// It also checks, offline, the lender terms arithmetic of the wasm against the core's vectors
// (`checkLenderTerms`), the app's conversion of typed terms (`checkTermsConversion`), the check
// of a directory entry the core signed (`checkDirectoryEntryParity`), the rules of the app's
// lending-key holder (`checkLendingKeyHolder`, `checkSyncInSession`) and the PSET builder's
// `'none'` blinding mode (`checkPsetBuilderNoneBlinding`).
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import * as lwk from 'lwk_wasm'

import type { DirectoryEntry } from '@/api/indexer/private'
import { resolveNetworkConfig } from '@/constants/resolve-network-config'
import { buildPset, type PsetInputSpec } from '@/lwk/psetBuilder'
import { createWaterfallsRecipientResolver } from '@/lwk/waterfallsRecipient'
import { checkDirectoryEntry } from '@/privateLending/directory'
import { inspectPset } from '@/privateLending/inspectPset'
import {
  APR_FORMAT_ERROR,
  EMPTY_PAIR_TERMS_FORM,
  lenderTermsFromForm,
  maxPrincipalPerCollateralFromDisplay,
  maxPrincipalPerCollateralToDisplay,
  otherPairs,
  type PairTermsForm,
  pairTermsFromForm,
  pairTermsToForm,
  U64_MAX,
  unitsFromDecimal,
  unitsToDecimal,
} from '@/privateLending/lenderTerms'
import { createLendingKeyHolder, syncInSession } from '@/privateLending/lendingKeyHolder'
import * as wasm from '@/wasm/private-lending/private_lending_wasm'

import {
  type PrivateLendingSources,
  type PrivateOfferArguments,
  type PrivateOfferScripts,
  privateOfferScripts,
  toPrivateOfferArguments,
  verifyOfferAddresses,
} from '../src/simplicity/private-lending/scripts'
import {
  buildPrivateLendingWitness,
  type PrivateLendingWitness,
} from '../src/simplicity/private-lending/witness'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, '..')
const simfDir = path.resolve(webRoot, '../crates/contracts/simf')

interface Fixture {
  program_id: string
  borrower_master_blinding_key: string
  lender_master_blinding_key: string
  creation_tx: string
  arguments: {
    borrower_nft_asset_id: string
    lender_nft_asset_id: string
    pending_collateral_commitment: string
    active_collateral_commitment: string
    principal_commitment: string
    repayment_commitment: string
    expiry_hash: string
    repayment_asset_prefix_bit: number
    repayment_asset_x: string
  }
  principal_output_script_hash: string
  repayment_output_script_hash: string
  installment_output_script_hash: string
  pending_offer_script_pubkey: string
  active_offer_script_pubkey: string
  lender_nft_script_pubkey: string
  witness_vectors: {
    full_repayment: WitnessVector & { debt_hash: string }
    liquidation: WitnessVector & { debt_hash: string; salt: string; expiry: number }
  }
}

// A synthetic spend of the fixture's active offer by one branch, and the witness the contracts'
// Rust serializes for it: the transaction, the transaction whose outputs are its prevouts, the
// offer's input and the witness bytes, all hex.
interface WitnessVector {
  prevouts_tx: string
  tx: string
  input_index: number
  witness: string
}

const fixture = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures/private-lending-parity.json'), 'utf-8'),
) as Fixture

// Written by the `parity_vectors` test of `crates/private-lending-core/src/lender_terms.rs`, in the
// JSON the wasm takes: u64 amounts as decimal strings, u32 fields as numbers.
interface LenderTermsPair {
  principal_asset: string
  collateral_asset: string
  min_apr_bps: number
  max_principal_per_collateral: string
  min_term_days: number
  max_term_days: number
  min_principal: string
  max_principal: string
}

interface LenderTermsVector {
  name: string
  terms: { pairs: LenderTermsPair[] }
  proposal: {
    principal_asset: string
    collateral_asset: string
    principal_amount: string
    collateral_amount: string
    repayment_amount: string
    term_blocks: number
  }
  // null is the core's None
  min_repayment: string | null
  min_collateral: string | null
  apr_bps: string | null
  principal_per_collateral: string | null
  check_proposal: string[]
}

const lenderTermsFixture = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures/lender-terms-parity.json'), 'utf-8'),
) as { vectors: LenderTermsVector[] }

// Written by the `directory_parity_entry` test of `crates/private-lending-core/src/directory.rs`:
// an entry the core signed, as the indexer serves it without its timestamps.
const directoryFixture = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures/directory-parity.json'), 'utf-8'),
) as {
  entry: Pick<
    DirectoryEntry,
    'pubkey' | 'display_name' | 'terms' | 'signed_challenge' | 'signature'
  >
}

function readSimf(name: string): string {
  // Trimmed, as simplicitySourcesPlugin does.
  return fs.readFileSync(path.join(simfDir, `${name}.simf`), 'utf-8').trim()
}

function report(line: string): void {
  process.stdout.write(`${line}\n`)
}

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`)
    process.exit(1)
  }
  report(`ok   ${name}`)
}

function equal(name: string, actual: string | number, expected: string | number): void {
  check(name, actual === expected, `got ${actual}, expected ${expected}`)
}

function expectedArguments(): PrivateOfferArguments {
  const a = fixture.arguments
  return {
    borrowerNftAssetId: a.borrower_nft_asset_id,
    lenderNftAssetId: a.lender_nft_asset_id,
    pendingCollateralCommitment: a.pending_collateral_commitment,
    activeCollateralCommitment: a.active_collateral_commitment,
    principalCommitment: a.principal_commitment,
    repaymentCommitment: a.repayment_commitment,
    expiryHash: a.expiry_hash,
    repaymentAssetPrefixBit: a.repayment_asset_prefix_bit,
    repaymentAssetX: a.repayment_asset_x,
  }
}

function expiryHashOf(salt: string, expiry: number): string {
  const height = Buffer.alloc(4)
  height.writeUInt32BE(expiry)
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(salt, 'hex'), height]))
    .digest('hex')
}

function throws(compute: () => unknown): boolean {
  try {
    compute()
    return false
  } catch {
    return true
  }
}

function buildsWitness(witness: PrivateLendingWitness): boolean {
  try {
    buildPrivateLendingWitness(witness)
    return true
  } catch {
    return false
  }
}

function hex(script: lwk.Script): string {
  return Buffer.from(script.bytes()).toString('hex')
}

async function main(): Promise<void> {
  await lwk.default({
    module_or_path: fs.readFileSync(path.join(webRoot, 'node_modules/lwk_wasm/lwk_wasm_bg.wasm')),
  })
  await wasm.default({
    module_or_path: fs.readFileSync(
      path.join(webRoot, 'src/wasm/private-lending/private_lending_wasm_bg.wasm'),
    ),
  })

  const sources: PrivateLendingSources = {
    privateLending: readSimf('private_lending'),
    assetAuth: readSimf('asset_auth'),
    scriptAuth: readSimf('script_auth'),
  }
  const network = lwk.Network.regtestDefault()
  const creationTx = lwk.Transaction.fromString(fixture.creation_tx)

  equal('program id', wasm.privateLendingProgramId(), fixture.program_id)

  const borrower = wasm.LendingKey.fromMasterBlindingKey(fixture.borrower_master_blinding_key)
  const lender = wasm.LendingKey.fromMasterBlindingKey(fixture.lender_master_blinding_key)
  const asLender = wasm.openCreationAsLender(lender, fixture.creation_tx)
  const asBorrower = wasm.openCreationAsBorrower(borrower, fixture.creation_tx)

  // The view tag is in the marker output; the nonce is that of the pending offer output.
  const marker = findMarker(creationTx)
  check('view tag matches the lender', wasm.viewTagMatches(lender, marker.nonce, marker.viewTag))
  check(
    'creation is the borrower own candidate',
    wasm.isOwnCandidate(
      borrower,
      asBorrower.firstInput(),
      asBorrower.borrowerNft(),
      asBorrower.lenderNft(),
      marker.nonce,
    ),
  )

  const expected = expectedArguments()
  for (const [who, opened] of [
    ['lender', asLender],
    ['borrower', asBorrower],
  ] as const) {
    const got = toPrivateOfferArguments(opened.contractArguments())
    check(
      `contract arguments as ${who}`,
      JSON.stringify(got) === JSON.stringify(expected),
      `${JSON.stringify(got)} != ${JSON.stringify(expected)}`,
    )
  }

  // The liquidation's witness carries the salt and the expiry that open the program's expiry hash.
  equal('expiry salt of both sides', asBorrower.expirySalt(), asLender.expirySalt())
  equal(
    'expiry hash is the SHA-256 of the salt and the big-endian expiry',
    expiryHashOf(asLender.expirySalt(), asLender.loanExpirationTime()),
    expected.expiryHash,
  )
  check(
    'the liquidation witness takes the debt hash, the salt and the expiry',
    buildsWitness({
      branch: 'Liquidation',
      debtHash: expected.repaymentCommitment,
      salt: asLender.expirySalt(),
      expiry: asLender.loanExpirationTime(),
    }),
  )
  check(
    'the liquidation witness refuses a short salt',
    !buildsWitness({
      branch: 'Liquidation',
      debtHash: expected.repaymentCommitment,
      salt: asLender.expirySalt().slice(2),
      expiry: 1,
    }),
  )
  check(
    'the full repayment witness refuses a short debt hash',
    !buildsWitness({ branch: 'FullRepayment', debtHash: expected.repaymentCommitment.slice(2) }),
  )

  // The blinder strings of the wasm are in LWK's format: LWK secrets built from them commit to
  // the same asset and value as the creation transaction's pending collateral output.
  const pending = asLender.pinned(wasm.PinnedRole.PendingCollateral)
  const lwkSecrets = new lwk.TxOutSecrets(
    lwk.AssetId.fromString(pending.asset),
    lwk.AssetBlindingFactor.fromString(pending.assetBlinder),
    pending.amount,
    lwk.ValueBlindingFactor.fromString(pending.valueBlinder),
  )
  equal(
    'LWK asset commitment of the pending collateral',
    lwkSecrets.assetCommitment(),
    pending.assetCommitment,
  )
  equal(
    'LWK value commitment of the pending collateral',
    lwkSecrets.valueCommitment(),
    pending.valueCommitment,
  )
  check(
    'pending collateral commitments are those of creation output 3',
    outputBytesHex(creationTx).includes(pending.assetCommitment) &&
      outputBytesHex(creationTx).includes(pending.valueCommitment),
  )

  const scripts = privateOfferScripts(sources, expected, network)
  equal(
    'principal output script hash',
    scripts.principalOutputScriptHash,
    fixture.principal_output_script_hash,
  )
  equal(
    'repayment output script hash',
    scripts.repaymentOutputScriptHash,
    fixture.repayment_output_script_hash,
  )
  equal(
    'installment output script hash',
    scripts.installmentOutputScriptHash,
    fixture.installment_output_script_hash,
  )
  equal('pending offer script', hex(scripts.pendingOffer), fixture.pending_offer_script_pubkey)
  equal('active offer script', hex(scripts.activeOffer), fixture.active_offer_script_pubkey)
  equal('lender NFT lock script', hex(scripts.lenderNftLock), fixture.lender_nft_script_pubkey)

  check('creation tx addresses verify', verifyOfferAddresses(scripts, creationTx))

  const tampered = {
    ...expected,
    repaymentCommitment: tamperLastHexDigit(expected.repaymentCommitment),
  }
  const tamperedScripts = privateOfferScripts(sources, tampered, network)
  check(
    'tampered repayment commitment is rejected',
    !verifyOfferAddresses(tamperedScripts, creationTx),
  )
  // The fixture's offer has one prefix bit of `A`; the other gives another program.
  const otherBit = { ...expected, repaymentAssetPrefixBit: 1 - expected.repaymentAssetPrefixBit }
  check(
    'the prefix bit of the repayment asset enters the program',
    !verifyOfferAddresses(privateOfferScripts(sources, otherBit, network), creationTx),
  )

  checkWitnessVectors(scripts, network)

  checkLenderTerms()
  checkTermsConversion()
  checkDirectoryEntryParity()
  await checkLendingKeyHolder()
  await checkSyncInSession()
  await checkWaterfallsRecipient()
  checkPsetBuilderNoneBlinding()

  report('private lending parity: ok')
}

/**
 * The web's witnesses of the branches it builds, run by LWK on the fixture's synthetic spends of the
 * active offer: each must give the bytes the contracts' Rust serializes for the same values, so a
 * wrong byte order of a 32-byte value cannot pass. A reversed debt hash or salt must fail to run.
 */
function checkWitnessVectors(scripts: PrivateOfferScripts, network: lwk.Network): void {
  const { full_repayment: repayment, liquidation } = fixture.witness_vectors
  const reversed = (value: string) => Buffer.from(value, 'hex').reverse().toString('hex')
  const cases: [string, WitnessVector, (reverse: boolean) => PrivateLendingWitness][] = [
    [
      'full repayment',
      repayment,
      reverse => ({
        branch: 'FullRepayment',
        debtHash: reverse ? reversed(repayment.debt_hash) : repayment.debt_hash,
      }),
    ],
    [
      'liquidation',
      liquidation,
      reverse => ({
        branch: 'Liquidation',
        debtHash: liquidation.debt_hash,
        salt: reverse ? reversed(liquidation.salt) : liquidation.salt,
        expiry: liquidation.expiry,
      }),
    ],
  ]
  for (const [name, vector, witness] of cases) {
    const run = (reverse: boolean) =>
      scripts.program.run(
        lwk.Transaction.fromString(vector.tx),
        scripts.activeSpendInfo.controlBlock(scripts.program.cmr),
        lwk.Transaction.fromString(vector.prevouts_tx).outputs,
        vector.input_index,
        buildPrivateLendingWitness(witness(reverse)),
        network,
        lwk.SimplicityLogLevel.None,
      )
    equal(
      `${name} witness bytes are the Rust ones`,
      Buffer.from(run(false).witnessBytes).toString('hex'),
      vector.witness,
    )
    check(
      `${name} with a reversed 32-byte value fails`,
      throws(() => run(true)),
    )
  }
}

/**
 * Every vector of the core's lender terms fixture, through the wasm: the terms survive an encoding
 * round trip, the proposal check names the same breaches, and the four amounts match. As the
 * fixture's description says, `minRepayment` and `minCollateral` take the rates of the pair with
 * the proposal's assets, or of the first pair when none has them. A `null` amount is the core's
 * `None`, which the wasm throws as a `bad-input:` error.
 */
function checkLenderTerms(): void {
  const amount = (compute: () => bigint): string | null => {
    try {
      return compute().toString()
    } catch (error) {
      if (typeof error === 'string' && error.startsWith('bad-input:')) return null
      throw error
    }
  }
  // The JSON with its keys sorted, so the decoded terms compare whatever the key order.
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, inner: unknown) =>
      inner !== null && typeof inner === 'object' && !Array.isArray(inner)
        ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)))
        : inner,
    )

  const { vectors } = lenderTermsFixture
  check('lender terms: the fixture has vectors', vectors.length > 0)
  for (const vector of vectors) {
    const name = (what: string) => `lender terms "${vector.name}": ${what}`
    const terms = JSON.stringify(vector.terms)
    const { proposal } = vector

    const decoded = wasm.decodeLenderTerms(wasm.encodeLenderTerms(terms))
    check(
      name('encoding round trip'),
      canonical(JSON.parse(decoded)) === canonical(vector.terms),
      decoded,
    )
    const breaches = wasm.checkProposal(terms, JSON.stringify(proposal))
    check(
      name('proposal check'),
      JSON.stringify(breaches) === JSON.stringify(vector.check_proposal),
      `got ${JSON.stringify(breaches)}, expected ${JSON.stringify(vector.check_proposal)}`,
    )

    const rates =
      vector.terms.pairs.find(
        pair =>
          pair.principal_asset === proposal.principal_asset &&
          pair.collateral_asset === proposal.collateral_asset,
      ) ?? vector.terms.pairs[0]
    const principal = BigInt(proposal.principal_amount)
    const amounts = {
      min_repayment: amount(() =>
        wasm.minRepayment(principal, rates.min_apr_bps, proposal.term_blocks),
      ),
      min_collateral: amount(() =>
        wasm.minCollateral(principal, BigInt(rates.max_principal_per_collateral)),
      ),
      apr_bps: amount(() =>
        wasm.aprBps(principal, BigInt(proposal.repayment_amount), proposal.term_blocks),
      ),
      principal_per_collateral: amount(() =>
        wasm.principalPerCollateral(principal, BigInt(proposal.collateral_amount)),
      ),
    }
    for (const [field, got] of Object.entries(amounts)) {
      const expected = vector[field as keyof typeof amounts]
      check(name(field), got === expected, `got ${got}, expected ${expected}`)
    }
  }
}

/** Whether `compute` throws a `RangeError`, as the terms conversion does on what it refuses. */
function refuses(compute: () => unknown): boolean {
  try {
    compute()
    return false
  } catch (error) {
    if (error instanceof RangeError) return true
    throw error
  }
}

/**
 * The conversion of what a lender types into terms (`src/privateLending/lenderTerms.ts`): the rate
 * per whole collateral coin to principal base units per 10^8 collateral base units and back,
 * exactly, against the wasm's arithmetic; and the terms form, whose terms the wasm accepts.
 */
function checkTermsConversion(): void {
  const fromDisplay = maxPrincipalPerCollateralFromDisplay
  const toDisplay = maxPrincipalPerCollateralToDisplay

  // [display, principal decimals, collateral decimals, base units per 10^8, or null if refused]
  const vectors: [string, number, number, bigint | null][] = [
    ['1', 3, 8, 1_000n],
    ['10000', 3, 8, 10_000_000n],
    ['0.001', 3, 8, 1n],
    [' 2.5 ', 3, 8, 2_500n],
    ['0', 3, 8, 0n],
    ['1', 8, 8, 100_000_000n],
    ['1', 2, 2, 100_000_000n],
    ['0.01', 2, 2, 1_000_000n],
    ['100', 8, 18, 1n],
    ['18446744073709551615', 0, 8, U64_MAX],
    ['184467440737095.51615', 5, 8, U64_MAX],
    // more decimals than the principal asset has
    ['0.0001', 3, 8, null],
    ['1.5', 0, 8, null],
    // not a whole number of base units per 10^8 collateral base units
    ['1', 8, 18, null],
    // above u64::MAX
    ['18446744073709551616', 0, 8, null],
    ['18446744073709552', 3, 8, null],
    // malformed
    ...['', ' ', '-1', '+1', '1e3', '.5', '5.', '0x10', '1,000', 'NaN', 'Infinity', '1 000'].map(
      (display): [string, number, number, null] => [display, 3, 8, null],
    ),
  ]
  for (const [display, principal, collateral, expected] of vectors) {
    const decimals = `${principal}/${collateral} decimals`
    const what = `terms conversion: ${JSON.stringify(display)} (${decimals})`
    if (expected === null) {
      check(
        `${what} is refused`,
        refuses(() => fromDisplay(display, principal, collateral)),
      )
    } else {
      const got = fromDisplay(display, principal, collateral)
      check(what, got === expected, `got ${got}, expected ${expected}`)
    }
  }
  for (const decimals of [Number.NaN, -1, 19, 1.5]) {
    check(
      `terms conversion: ${decimals} decimals are refused`,
      refuses(() => fromDisplay('1', decimals, 8)) &&
        refuses(() => fromDisplay('1', 3, decimals)) &&
        refuses(() => toDisplay(1n, decimals, 8)) &&
        refuses(() => unitsFromDecimal('1', decimals)),
    )
  }

  // The inverse: exact, and back to the same value whenever the principal's decimals suffice.
  equal('terms conversion: 1000 back', toDisplay(1_000n, 3, 8), '1')
  equal('terms conversion: 1 back', toDisplay(1n, 3, 8), '0.001')
  equal('terms conversion: u64::MAX back', toDisplay(U64_MAX, 3, 8), '18446744073709551.615')
  equal('terms conversion: 1 back, 2/2 decimals', toDisplay(1n, 2, 2), '0.00000001')
  equal('terms conversion: 1 back, 8/18 decimals', toDisplay(1n, 8, 18), '100')
  for (const [principal, collateral] of [
    [3, 8],
    [8, 8],
    [0, 8],
    [2, 2],
    [8, 18],
  ]) {
    for (const value of [0n, 1n, 999n, 1_000n, 10_000_000n, 123_456_789n, U64_MAX]) {
      const display = toDisplay(value, principal, collateral)
      const decimals = display.split('.')[1]?.length ?? 0
      check(
        `terms conversion: ${value} round trip (${principal}/${collateral} decimals)`,
        decimals <= principal
          ? fromDisplay(display, principal, collateral) === value
          : refuses(() => fromDisplay(display, principal, collateral)),
        display,
      )
    }
  }

  // Against the wasm: 1 TEST for 0.0002 tL-BTC is 5000 TEST per tL-BTC, which needs 0.0002 tL-BTC.
  const rate = wasm.principalPerCollateral(1_000n, 20_000n)
  equal('terms conversion: the wasm rate shown', toDisplay(rate, 3, 8), '5000')
  equal(
    'terms conversion: the least collateral at the typed rate',
    wasm.minCollateral(1_000n, fromDisplay('5000', 3, 8)).toString(),
    '20000',
  )

  // Whole coins, as the form's principal range takes them.
  equal('terms conversion: units', unitsFromDecimal('0.1', 3).toString(), '100')
  equal('terms conversion: units back', unitsToDecimal(100n, 3), '0.1')
  check(
    'terms conversion: units refuse 4 decimals of 3',
    refuses(() => unitsFromDecimal('0.0001', 3)),
  )
  check(
    'terms conversion: units refuse -1',
    refuses(() => unitsFromDecimal('-1', 3)),
  )
  check(
    'terms conversion: units refuse u64::MAX + 1',
    refuses(() => unitsFromDecimal('18446744073709551616', 0)),
  )

  // The form, for the testnet pair: its terms are terms the wasm takes, and they read back.
  const { collateralAsset, principalAsset } = resolveNetworkConfig('liquidtestnet', {})
  const pair = { collateral: collateralAsset, principal: principalAsset }
  const form: PairTermsForm = {
    minAprPercent: '5.25',
    maxPrincipalPerCollateral: '50000',
    minTermDays: '1',
    maxTermDays: '3650',
    minPrincipal: '0.001',
    maxPrincipal: '18446744073709551.615',
  }
  const parsed = pairTermsFromForm(form, pair)
  check(
    'terms form: a valid form gives terms',
    parsed.terms !== null,
    JSON.stringify(parsed.errors),
  )
  if (parsed.terms !== null) {
    check(
      'terms form: the terms',
      JSON.stringify(parsed.terms) ===
        JSON.stringify({
          principal_asset: principalAsset.id,
          collateral_asset: collateralAsset.id,
          min_apr_bps: 525,
          max_principal_per_collateral: '50000000',
          min_term_days: 1,
          max_term_days: 3650,
          min_principal: '1',
          max_principal: U64_MAX.toString(),
        }),
      JSON.stringify(parsed.terms),
    )
    const terms = { pairs: [parsed.terms] }
    const decoded = wasm.decodeLenderTerms(wasm.encodeLenderTerms(JSON.stringify(terms)))
    check(
      'terms form: the wasm takes the terms',
      isDeepStrictEqual(JSON.parse(decoded), terms),
      decoded,
    )
    check(
      'terms form: the terms read back into the form',
      JSON.stringify(pairTermsToForm(parsed.terms, pair)) === JSON.stringify(form),
      JSON.stringify(pairTermsToForm(parsed.terms, pair)),
    )
  }
  // [field, typed, rest of the form]: each is refused with an error on that field.
  const refusals: [keyof PairTermsForm, string, Partial<PairTermsForm>][] = [
    ['maxTermDays', '3651', {}],
    ['minTermDays', '0', {}],
    ['minTermDays', '1.5', {}],
    ['maxTermDays', '6', { minTermDays: '7' }],
    ['minPrincipal', '0.0001', {}],
    ['minPrincipal', '0', {}],
    ['maxPrincipal', '1', { minPrincipal: '2' }],
    ['maxPrincipal', '18446744073709551.616', {}],
    ['minAprPercent', '1.234', {}],
    ['minAprPercent', '42949672.96', {}],
    ['minAprPercent', '-1', {}],
    ['maxPrincipalPerCollateral', '0', {}],
    ['maxPrincipalPerCollateral', '0.0001', {}],
  ]
  for (const [field, typed, rest] of refusals) {
    const result = pairTermsFromForm({ ...form, ...rest, [field]: typed }, pair)
    check(
      `terms form: ${field} ${JSON.stringify(typed)} is refused`,
      result.terms === null && typeof result.errors[field] === 'string',
      JSON.stringify(result),
    )
  }
  for (const typed of ['1.234', '-1', 'six', '']) {
    const result = pairTermsFromForm({ ...form, minAprPercent: typed }, pair)
    equal(
      `terms form: the APR error for ${JSON.stringify(typed)}`,
      result.errors?.minAprPercent ?? '',
      APR_FORMAT_ERROR,
    )
  }
  // A served entry with a pair for other assets (as a hostile indexer could add): the form gives
  // its pair alone, and `termsToPublish` adds other pairs only from verified terms.
  if (parsed.terms !== null) {
    const injected = { ...parsed.terms, principal_asset: 'ab'.repeat(32) }
    const served = { pairs: [parsed.terms, injected] }
    const published = lenderTermsFromForm(form, pair)
    check(
      "terms form: the form's terms are its pair alone",
      isDeepStrictEqual(published.terms, { pairs: [parsed.terms] }),
      JSON.stringify(published),
    )
    check(
      'terms form: a served pair for other assets is found',
      isDeepStrictEqual(otherPairs(served, pair), [injected]) &&
        otherPairs({ pairs: [parsed.terms] }, pair).length === 0 &&
        otherPairs(null, pair).length === 0,
    )
    check(
      'terms form: an invalid form publishes nothing',
      lenderTermsFromForm({ ...form, maxTermDays: '3651' }, pair).terms === null,
    )
  }
  const largest = pairTermsFromForm({ ...form, minAprPercent: '42949672.95' }, pair)
  check('terms form: the largest APR is u32::MAX bps', largest.terms?.min_apr_bps === 2 ** 32 - 1)
  const empty = pairTermsFromForm(EMPTY_PAIR_TERMS_FORM, pair)
  check(
    'terms form: an empty form has an error on every field',
    empty.terms === null && Object.keys(empty.errors).length === 6,
  )
}

/**
 * An entry the core signed verifies in the wasm (`verifyDirectoryEntry`), with the terms as the
 * app serializes them and a name that is not ASCII; one changed rate, another name, another key or
 * another challenge does not. `checkDirectoryEntry` gives `verified` with the terms, `invalid` for
 * the changed entries and for malformed hex, and `unsigned` without a signature.
 */
function checkDirectoryEntryParity(): void {
  const entry: DirectoryEntry = {
    ...directoryFixture.entry,
    terms_published_at: 0,
    created_at: 0,
    updated_at: 0,
  }
  const { pubkey, display_name: name, terms, signed_challenge, signature } = entry
  if (terms === null || signed_challenge === null || signature === null) {
    check('directory entry: the fixture has terms and a signature', false)
    return
  }
  const termsJson = JSON.stringify(terms)
  const verify = (
    what: string,
    expected: boolean,
    changed: { pubkey?: string; challenge?: string; name?: string; termsJson?: string } = {},
  ) =>
    check(
      `directory entry: ${what} ${expected ? 'verifies' : 'does not verify'}`,
      wasm.verifyDirectoryEntry(
        changed.pubkey ?? pubkey,
        changed.challenge ?? signed_challenge,
        changed.name ?? name,
        changed.termsJson ?? termsJson,
        signature,
      ) === expected,
    )
  const pair = terms.pairs[0]
  const otherRate = { pairs: [{ ...pair, min_apr_bps: pair.min_apr_bps + 1 }] }
  const otherKey = wasm.LendingKey.fromMasterBlindingKey('02'.repeat(32)).xOnlyPublicKey()
  verify('the core-signed entry', true)
  verify('the entry in upper-case hex', true, {
    pubkey: pubkey.toUpperCase(),
    challenge: signed_challenge.toUpperCase(),
  })
  verify('one changed rate', false, { termsJson: JSON.stringify(otherRate) })
  verify('another name', false, { name: `${name} ` })
  verify('another key', false, { pubkey: otherKey })
  verify('another challenge', false, { challenge: '5d'.repeat(32) })

  const status = (changed: Partial<DirectoryEntry>) =>
    checkDirectoryEntry(wasm, { ...entry, ...changed }).status
  const verified = checkDirectoryEntry(wasm, entry)
  check(
    'directory entry: the core-signed entry is verified, with its terms',
    verified.status === 'verified' && isDeepStrictEqual(verified.terms, terms),
    JSON.stringify(verified),
  )
  const cases: [string, Partial<DirectoryEntry>, string][] = [
    ['one changed rate', { terms: otherRate }, 'invalid'],
    ['another name', { display_name: 'Acme Bank' }, 'invalid'],
    ['another key', { pubkey: otherKey }, 'invalid'],
    ['an entry whose terms the app could not read', { terms: null }, 'invalid'],
    ['a malformed signature', { signature: signature.slice(2) }, 'invalid'],
    ['a key off the curve', { pubkey: 'ff'.repeat(32) }, 'invalid'],
    ['no signature', { signature: null }, 'unsigned'],
    ['no challenge', { signed_challenge: null }, 'unsigned'],
  ]
  for (const [what, changed, expected] of cases) {
    const got = status(changed)
    check(`directory entry: ${what} is ${expected}`, got === expected, got)
  }
}

/**
 * In `'none'` mode, `buildPset` (`src/lwk/psetBuilder.ts`) leaves blinding to the caller. The
 * confidential outputs keep their blinding key, their blinder is the first `walletCoin` input
 * (else input 0), and nothing is committed until the private wasm's `blindPset` blinds the PSET.
 */
function checkPsetBuilderNoneBlinding(): void {
  const network = lwk.Network.testnet()
  const policyAsset = network.policyAsset()
  // The fixtures hold no address: this one is the lender NFT lock script, blinded to the lender.
  const lender = wasm.LendingKey.fromMasterBlindingKey(fixture.lender_master_blinding_key)
  const address = lwk.Address.parse(
    wasm.confidentialAddress(
      fixture.lender_nft_script_pubkey,
      wasm.liftLendingKey(lender.xOnlyPublicKey()),
      'liquidtestnet',
    ),
    network,
  )
  const coin = (vout: number, walletCoin: boolean): PsetInputSpec => ({
    outpoint: new lwk.OutPoint(`${'11'.repeat(32)}:${vout}`),
    prevout: lwk.TxOut.fromExplicit(address.scriptPubkey(), policyAsset, 100_000n),
    asset: policyAsset,
    amount: 100_000n,
    maxWeightToSatisfy: 300,
    walletCoin,
  })
  const build = (inputs: PsetInputSpec[]) =>
    buildPset({
      network,
      inputs,
      outputs: [
        {
          script: address.scriptPubkey(),
          amount: 10_000n,
          asset: policyAsset,
          blindingPubkey: address.blindingPubkey(),
        },
      ],
      changeAddress: address,
      feeRateSatPerKvb: 100,
      blinding: 'none',
    })
  const name = (what: string) => `pset builder 'none': ${what}`

  const { pset, fee } = build([coin(0, true)])
  const { outputs } = inspectPset(wasm, pset.toString())
  check(name('recipient, change and fee outputs'), outputs.length === 3, `${outputs.length}`)
  for (const [i, o] of outputs.slice(0, 2).entries()) {
    check(
      name(`output ${i} keeps its blinding key, blinder input 0`),
      o.blindingKey !== null && o.blinderIndex === 0,
      `key ${o.blindingKey}, blinder ${o.blinderIndex}`,
    )
    check(
      name(`output ${i} is not blinded`),
      o.assetCommitment === null && o.amountCommitment === null,
    )
  }
  check(
    name('the fee output'),
    outputs[2].script === '' && outputs[2].amount === fee && fee > 0n,
    `script '${outputs[2].script}', amount ${outputs[2].amount}, fee ${fee}`,
  )
  check(
    name('the change'),
    outputs[1].amount === 100_000n - 10_000n - fee,
    `${outputs[1].amount}, fee ${fee}`,
  )

  const blinded = inspectPset(
    wasm,
    wasm.blindPset(
      pset.toString(),
      [wasm.InputSecret.explicit(0, policyAsset.toString(), 100_000n)],
      [],
    ),
  )
  for (const i of [0, 1]) {
    const o = blinded.outputs[i]
    check(
      name(`blindPset commits output ${i}`),
      o.assetCommitment !== null && o.amountCommitment !== null,
    )
  }

  // Above, the only input is both the first walletCoin and input 0; these builds tell them apart.
  const blinders = (inputs: PsetInputSpec[]) =>
    inspectPset(wasm, build(inputs).pset.toString())
      .outputs.slice(0, 2)
      .map(o => o.blinderIndex)
      .join(',')
  const firstWalletCoin = blinders([coin(0, false), coin(1, true), coin(2, true)])
  check(name('the first walletCoin input blinds'), firstWalletCoin === '1,1', firstWalletCoin)
  const noWalletCoin = blinders([coin(0, false)])
  check(name('without a walletCoin input, input 0 blinds'), noWalletCoin === '0,0', noWalletCoin)
}

/**
 * The waterfalls recipient (`src/lwk/waterfallsRecipient.ts`) comes from the server's
 * `/v1/server_recipient` unless a pinned key is configured. A malformed answer is refused, one
 * fetch serves the session, and a failed fetch is not kept.
 */
async function checkWaterfallsRecipient(): Promise<void> {
  const key = 'age1gn0fp4wnwkwsct30ljcj98neljumzrxjxlud50rs7k3dlhkp4ewsdf59g5'
  const pinned = 'age1xxzrgrfjm3yrwh3u6a7exgrldked0pdauvr3mx870wl6xzrwm5ps8s2h0p'
  const urls: string[] = []
  let answer: () => Response = () => new Response(`${key}\n`)
  const resolve = createWaterfallsRecipientResolver(async input => {
    urls.push(String(input))
    return answer()
  })
  const rejects = (promise: Promise<unknown>) =>
    promise.then(
      () => false,
      () => true,
    )

  equal('waterfalls recipient: fetched from the server', await resolve('https://w.test/'), key)
  equal(
    'waterfalls recipient: the server_recipient endpoint',
    urls[0],
    'https://w.test/v1/server_recipient',
  )
  await resolve('https://w.test')
  check('waterfalls recipient: one fetch per server', urls.length === 1)
  equal('waterfalls recipient: a pinned key wins', await resolve('https://p.test', pinned), pinned)
  check('waterfalls recipient: a pinned key fetches nothing', urls.length === 1)
  check(
    'waterfalls recipient: a malformed pinned key is refused',
    await rejects(resolve('https://p.test', 'age1nope')),
  )

  answer = () => new Response('<html>not a key</html>')
  check(
    'waterfalls recipient: a malformed answer is refused',
    await rejects(resolve('https://bad.test')),
  )
  answer = () => new Response('endpoint not found', { status: 404 })
  check(
    'waterfalls recipient: an HTTP error is refused',
    await rejects(resolve('https://gone.test')),
  )
  answer = () => new Response(key)
  equal('waterfalls recipient: a failed fetch is retried', await resolve('https://gone.test'), key)
}

/**
 * The lending-key holder (`src/privateLending/lendingKeyHolder.ts`) frees keys and drops the
 * session's private cache (`onSessionEnd`) only when a session ends. Deriving the first key of a
 * session, deriving again after a failure, or deriving for a new session must not drop the cache:
 * the caller is usually a query that would remove itself mid-fetch.
 */
async function checkLendingKeyHolder(): Promise<void> {
  interface Session {
    descriptor: string
  }
  const descriptorOf = (masterBlindingKey: string) => `ct(slip77(${masterBlindingKey}),elwpkh(x))`
  let current: Session | null = null
  let sessionEnds = 0
  const holder = createLendingKeyHolder<Session>({
    loadWasm: async () => wasm,
    descriptorOf: session => session.descriptor,
    isCurrent: session => current === session,
    onSessionEnd: () => sessionEnds++,
  })
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  const isFreed = (key: wasm.LendingKey) => {
    try {
      key.fingerprint()
      return false
    } catch {
      return true
    }
  }

  const first: Session = { descriptor: descriptorOf(fixture.lender_master_blinding_key) }
  current = first
  const derivation = holder.get(first)
  check('lending key holder: one derivation per session', holder.get(first) === derivation)
  const firstKey = await derivation
  equal(
    'lending key holder: the key of the descriptor',
    firstKey.fingerprint(),
    wasm.LendingKey.fromMasterBlindingKey(fixture.lender_master_blinding_key).fingerprint(),
  )
  check('lending key holder: deriving does not end the session', sessionEnds === 0)

  const broken: Session = { descriptor: 'no slip77 key' }
  current = broken
  const failed = holder.get(broken)
  const failure = await failed.then(
    () => null,
    (error: unknown) => error,
  )
  await settle()
  check(
    'lending key holder: a new session frees the old key without ending a session',
    isFreed(firstKey) && sessionEnds === 0,
  )
  check(
    'lending key holder: a failed derivation is not kept, and retrying ends no session',
    failure !== null && holder.get(broken) !== failed && sessionEnds === 0,
  )
  await holder.get(broken).catch(() => {})

  const second: Session = { descriptor: descriptorOf(fixture.borrower_master_blinding_key) }
  current = second
  const secondKey = await holder.get(second)
  current = null
  holder.endSession()
  await settle()
  check(
    'lending key holder: a session end frees the key and drops the cache once',
    isFreed(secondKey) && sessionEnds === 1,
  )

  const third: Session = { descriptor: descriptorOf(fixture.borrower_master_blinding_key) }
  current = third
  const pending = holder.get(third)
  current = null
  holder.endSession()
  const outcome = await pending.then(
    () => 'key',
    () => 'no key',
  )
  check(
    'lending key holder: a session that ends mid-derivation gets no key',
    outcome === 'no key' && sessionEnds === 2,
  )
}

/**
 * `syncInSession` (`src/privateLending/lendingKeyHolder.ts`) lets a private build go on after its
 * wallet sync only in the session the sync started in. A switch to another wallet, or to none,
 * during the sync fails the build with a readable error instead of building in the new session.
 * A rejected promise left unhandled here would end the script.
 */
async function checkSyncInSession(): Promise<void> {
  interface Session {
    descriptor: string
  }
  const descriptorOf = (masterBlindingKey: string) => `ct(slip77(${masterBlindingKey}),elwpkh(x))`
  let current: Session | null = null
  const holder = createLendingKeyHolder<Session>({
    loadWasm: async () => wasm,
    descriptorOf: session => session.descriptor,
    isCurrent: session => current === session,
    onSessionEnd: () => {},
  })
  // As the provider's `getLendingKey`: no session, or a session without a key, gives a new
  // rejected promise on every call.
  const getKey = (): Promise<wasm.LendingKey> =>
    current ? holder.get(current) : Promise.reject(new Error('not connected'))
  const switchTo = (next: Session | null) => {
    current = null
    holder.endSession()
    current = next
  }
  const errorOf = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
  const sessionOf = (masterBlindingKey: string): Session => ({
    descriptor: descriptorOf(masterBlindingKey),
  })
  const name = (what: string) => `sync in session: ${what}`
  const switched = 'The wallet changed while it was syncing, so nothing was built. Try again.'

  current = sessionOf(fixture.lender_master_blinding_key)
  const key = await syncInSession(getKey, async () => {})
  equal(
    name('an unchanged session gives its key'),
    key.fingerprint(),
    wasm.LendingKey.fromMasterBlindingKey(fixture.lender_master_blinding_key).fingerprint(),
  )

  const toOther = await errorOf(
    syncInSession(getKey, async () => switchTo(sessionOf(fixture.borrower_master_blinding_key))),
  )
  equal(name('a switch to another wallet stops the build'), String(toOther), switched)

  const toNone = await errorOf(syncInSession(getKey, async () => switchTo(null)))
  equal(name('a disconnect stops the build'), String(toNone), switched)

  switchTo(sessionOf(fixture.lender_master_blinding_key))
  const failedSync = await errorOf(
    syncInSession(getKey, async () => {
      throw new Error('scan failed')
    }),
  )
  equal(name('a failed sync fails with its own error'), String(failedSync), 'scan failed')

  switchTo(null)
  let synced = false
  const noKey = await errorOf(
    syncInSession(getKey, async () => {
      synced = true
    }),
  )
  check(
    name('a key that cannot be had fails first, with its own error, and nothing syncs'),
    noKey === 'not connected' && !synced,
    `${noKey}, synced ${synced}`,
  )
  holder.endSession()
}

function outputBytesHex(tx: lwk.Transaction): string {
  return Buffer.from(tx.toBytes()).toString('hex')
}

function tamperLastHexDigit(value: string): string {
  const last = value.slice(-1)
  return value.slice(0, -1) + (last === '0' ? '1' : '0')
}

// The marker is the OP_RETURN output, holding <program id (4)> <view tag (1)> <encrypted key (32)>.
// LWK does not expose output nonces, so the nonce (33 bytes) is read from the serialized
// transaction: it sits right before the length byte of the pending offer's script.
function findMarker(tx: lwk.Transaction): { nonce: string; viewTag: number } {
  let viewTag: number | undefined
  for (const output of tx.outputs) {
    const bytes = output.scriptPubkey().bytes()
    if (bytes[0] === 0x6a && bytes[1] === 37) viewTag = bytes[2 + 4]
  }
  if (viewTag === undefined) throw new Error('no marker output')

  const raw = Buffer.from(tx.toBytes())
  const scriptAt = raw.indexOf(Buffer.from(fixture.pending_offer_script_pubkey, 'hex'))
  if (scriptAt < 34) throw new Error('pending offer output not found')
  const nonce = raw.subarray(scriptAt - 1 - 33, scriptAt - 1).toString('hex')
  return { nonce, viewTag }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
