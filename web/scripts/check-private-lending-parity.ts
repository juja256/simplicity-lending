// Proves that the browser (LWK + the private-lending wasm) derives the same offer addresses
// as the Rust code. Run it with `pnpm parity`; it must pass before browser addresses are relied on.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as lwk from '@lilbonekit/lwk-web'

import * as wasm from '@/wasm/private-lending/private_lending_wasm'

import {
  type PrivateLendingSources,
  type PrivateOfferArguments,
  privateOfferScripts,
  toPrivateOfferArguments,
  verifyOfferAddresses,
} from '../src/simplicity/private-lending/scripts'

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
    loan_expiration_time: number
  }
  principal_output_script_hash: string
  repayment_output_script_hash: string
  pending_offer_script_pubkey: string
  active_offer_script_pubkey: string
  lender_nft_script_pubkey: string
}

const fixture = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures/private-lending-parity.json'), 'utf-8'),
) as Fixture

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
    loanExpirationTime: a.loan_expiration_time,
  }
}

function hex(script: lwk.Script): string {
  return Buffer.from(script.bytes()).toString('hex')
}

async function main(): Promise<void> {
  await lwk.default({
    module_or_path: fs.readFileSync(
      path.join(webRoot, 'node_modules/@lilbonekit/lwk-web/lwk_wasm_bg.wasm'),
    ),
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

  report('private lending parity: ok')
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
