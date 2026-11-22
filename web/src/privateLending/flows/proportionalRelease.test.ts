// The flows of proportional release, built for real on the parity fixture's offer: blinded PSETs
// from a fake chain, a real wallet (for the PSET's details and addresses) and stand-in coins, and,
// where the flow finalizes, the contract's own programs run on the built transaction. The wallet's
// `finalize` is left out (the coins are stand-ins), so a finalization that ran every covenant
// stops at the first wallet input, which nothing signed.
import type { WalletTxOut } from 'lwk_wasm'
import { describe, expect, it } from 'vitest'

import {
  CANCELLATION_OUTPUT,
  CARRY_SUPPLY,
  CREATION_OUTPUT,
  INSTALLMENT_OUTPUT,
  REPAYMENT_OUTPUT,
} from '@/simplicity/private-lending/layout'
import { PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY } from '@/simplicity/private-lending/witness'
import { lwk } from '@/test/lwk'
import {
  acceptanceTxid,
  creationTxid,
  fakeChain,
  fixture,
  installmentHex,
  installmentTxid,
  keys,
  openOffer,
  OTHER_ASSET,
  standIn,
  txidOf,
  WALLET_SCRIPT,
} from '@/test/privateChain'
import { wasm } from '@/test/wasm'
import type { LoanState } from '@/wasm/private-lending/private_lending_wasm'

import { AddressCursor } from '../addressCursor'
import type { PrivateFlowDeps } from '../deps'
import { inspectPset } from '../inspectPset'
import { creationCarrySupply, loadLoan, type Loan, newIssuance } from '../loan'
import {
  checkLenderBounds,
  openAndVerifyOffer,
  PrivateOfferError,
  type VerifiedOffer,
} from '../verify'
import { buildPrivateCancellation } from './cancellation'
import { buildPrivateCreation, offerBoundsError } from './creation'
import { buildPrivateInstallment, R2_EXTRA_OUTPUT_AMOUNT } from './installment'
import { buildPrivateLiquidation, type CollateralFinder } from './liquidation'
import { buildPrivateRepayment } from './repayment'
import { outpointOf } from './shared'

const network = lwk.Network.regtestDefault()
const wollet = new lwk.Wollet(
  network,
  new lwk.Signer(
    new lwk.Mnemonic(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    ),
    network,
  ).wpkhSlip77Descriptor(),
)
/** The wallet, with `finalize` leaving the PSET as it is: nothing signs the stand-in coins. */
const unsigningWollet = new Proxy(wollet, {
  get(target, property) {
    if (property === 'finalize') return (pset: unknown) => pset
    const value: unknown = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  },
})

let coinSeed = 0
/** A wallet coin of `value` units of `asset`, explicit, in a stand-in transaction of its own. */
function walletCoin(asset: string, value: bigint): { coin: WalletTxOut; tx: string } {
  coinSeed += 1
  const tx = standIn(
    [`${coinSeed.toString(16).padStart(64, '0')}:0`],
    [{ script: WALLET_SCRIPT, asset, value }],
  )
  const coin = {
    outpoint: () => new lwk.OutPoint(`${txidOf(tx)}:0`),
    unblinded: () => lwk.TxOutSecrets.fromExplicit(lwk.AssetId.fromString(asset), value),
  } as unknown as WalletTxOut
  return { coin, tx }
}

/** The fake chain's deps with `extra`, a real wallet, fresh addresses and a fee rate: they build. */
function buildingDeps(extra: string[], wasmOverride?: Partial<PrivateFlowDeps['wasm']>) {
  const chain = fakeChain(...extra)
  Object.defineProperty(chain.deps, 'feeRate', { value: 100 })
  Object.assign(chain.deps, {
    wollet: unsigningWollet,
    addresses: new AddressCursor(),
    ...(wasmOverride === undefined ? {} : { wasm: { ...wasm, ...wasmOverride } }),
  })
  return chain
}

/** A claim of the offer's principal: it holds the borrower NFT at its output 0. */
function principalClaim(offer: VerifiedOffer): string {
  return standIn(
    [`${acceptanceTxid}:1`, `${creationTxid}:0`],
    [{ script: WALLET_SCRIPT, asset: offer.opened.borrowerNft(), value: 1n }],
  )
}

const inspect = (pset: { toString(): string }) => inspectPset(wasm, pset.toString())

/** The borrower's loan at `loanOutpoint`, read through a chain that has `extra`. */
async function borrowerLoan(offer: VerifiedOffer, loanOutpoint: string, extra: string[] = []) {
  return loadLoan(fakeChain(...extra).deps, offer, keys.borrower, loanOutpoint)
}

/** The loan's carries as the chain gives them, which the indexer would list. */
function chainCarries(loan: Loan): string[] {
  const carries = loan.state.carries()
  const outpoints = carries.map(carry => carry.outpoint)
  carries.forEach(carry => carry.free())
  return outpoints
}

interface InstallmentBuild {
  amount: bigint
  /** The extra transactions the chain needs: the claim, the coins, earlier installments. */
  chain: string[]
  loan: Loan
  claim: string
  offer: VerifiedOffer
  principal?: { coin: WalletTxOut; tx: string }
  earlierBuilds?: string[]
  carryOutpoints?: string[]
  wasmOverride?: Partial<PrivateFlowDeps['wasm']>
}

/** Builds an installment of `amount`, from a principal coin of 5,000 units, and a fee coin. */
async function buildInstallment(spec: InstallmentBuild) {
  const { offer, loan } = spec
  const principal = spec.principal ?? walletCoin(offer.opened.principalAsset(), 5_000n)
  const fee = walletCoin(OTHER_ASSET, 100_000n)
  const { deps } = buildingDeps(
    [...spec.chain, spec.claim, principal.tx, fee.tx],
    spec.wasmOverride,
  )
  const built = await buildPrivateInstallment(deps, offer, loan, {
    amount: spec.amount,
    borrowerNftOutpoint: `${txidOf(spec.claim)}:0`,
    principalCoins: [principal.coin],
    feeCoins: [fee.coin],
    carryOutpoints: spec.carryOutpoints ?? chainCarries(loan),
    earlierBuilds: spec.earlierBuilds ?? [],
    lendingKey: keys.borrower,
    tipHeight: offer.opened.loanExpirationTime() - 10,
  })
  const tx = built.pset.extractTx()
  return { built, tx, hex: tx.toString(), txid: tx.txid().toString(), principal, fee }
}

/** An amount at the loan's state whose release is 0, and one whose release is not. */
function amountsByRelease(state: LoanState): { none: bigint; some: bigint } {
  const owed = state.remaining ?? 0n
  let none: bigint | undefined
  let some: bigint | undefined
  for (let amount = 1n; amount < owed && (none === undefined || some === undefined); amount += 1n) {
    if (state.releasePreview(amount) === 0n) none ??= amount
    else some ??= amount
  }
  if (none === undefined || some === undefined) throw new Error('no such amounts')
  return { none, some }
}

/**
 * The range proofs of `tx`'s outputs, from its consensus encoding (LWK does not expose them):
 * empty for an explicit output.
 */
function outputRangeProofs(tx: { toBytes(): Uint8Array; outputs: unknown[] }): Uint8Array[] {
  const bytes = tx.toBytes()
  let at = 0
  const take = (n: number) => bytes.subarray(at, (at += n))
  const varInt = () => {
    const first = take(1)[0]
    if (first < 0xfd) return first
    const size = first === 0xfd ? 2 : first === 0xfe ? 4 : 8
    return take(size).reduceRight((value, byte) => value * 256 + byte, 0)
  }
  const confidential = (explicitSize: number) => {
    const prefix = take(1)[0]
    if (prefix === 0) return
    take(prefix === 1 ? explicitSize : 32)
  }
  take(4)
  const hasWitness = take(1)[0] === 1
  const inputs = varInt()
  for (let i = 0; i < inputs; i += 1) {
    take(32)
    const vout = take(4).reduceRight((value, byte) => value * 256 + byte, 0)
    take(varInt())
    take(4)
    if (vout !== 0xffffffff && vout >= 0x80000000) {
      take(64)
      confidential(8)
      confidential(8)
    }
  }
  const outputs = varInt()
  for (let i = 0; i < outputs; i += 1) {
    confidential(32)
    confidential(8)
    confidential(32)
    take(varInt())
  }
  take(4)
  if (!hasWitness) return Array.from({ length: outputs }, () => new Uint8Array())
  for (let i = 0; i < inputs; i += 1) {
    take(varInt())
    take(varInt())
    for (let part = 0; part < 2; part += 1) {
      const items = varInt()
      for (let item = 0; item < items; item += 1) take(varInt())
    }
  }
  return Array.from({ length: outputs }, () => {
    take(varInt()) // surjection proof
    return take(varInt()).slice()
  })
}

/** The serialized script witness of input `index` of `hex`: what it weighs. */
function scriptWitnessWeight(hex: string, index: number): number {
  const items = lwk.Transaction.fromString(hex).inputs[index].witness().scriptWitness
  const varIntSize = (n: number) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5)
  return items.reduce(
    (weight, item) => weight + varIntSize(item.length / 2) + item.length / 2,
    varIntSize(items.length),
  )
}

describe('the creation of proportional release', () => {
  /** The creation's coins: two policy coins issue the NFTs, the collateral coin the carry token. */
  function creationCoins(collateralAsset: string, collateral: bigint) {
    return {
      first: walletCoin(OTHER_ASSET, 50_000n),
      lenderNft: walletCoin(OTHER_ASSET, 50_000n),
      collateral: walletCoin(collateralAsset, collateral),
    }
  }

  async function buildCreation(collateral: bigint, repayment: bigint) {
    const collateralAsset = 'c0'.repeat(32)
    const coins = creationCoins(collateralAsset, collateral)
    const { deps, fetched } = buildingDeps([
      coins.first.tx,
      coins.lenderNft.tx,
      coins.collateral.tx,
    ])
    Object.assign(deps, {
      assets: { policy: OTHER_ASSET, principal: 'a0'.repeat(32), collateral: collateralAsset },
    })
    const built = buildPrivateCreation(deps, {
      borrower: keys.borrower,
      lender: keys.lender.xOnlyPublicKey(),
      firstInput: coins.first.coin,
      lenderNftCoin: coins.lenderNft.coin,
      collateralCoins: [coins.collateral.coin],
      collateralAmount: collateral,
      principalAmount: repayment / 2n,
      repaymentAmount: repayment,
      loanExpirationTime: 5_000,
      borrowerNftReceiver: unsigningWollet.address(1).address(),
    })
    return { built, deps, fetched, coins }
  }

  // Review focus 3, O9: the largest collateral and full repayment a lender accepts, built by the
  // borrower's flow, and opened through the lender's gate.
  it('issues the carry supply at input 2 into output 4, and the lender accepts C = 2^44, R = 2^50 − 2', async () => {
    const { built, deps, coins } = await buildCreation(1n << 44n, (1n << 50n) - 2n)
    const { pset, finalize } = await built
    const { inputs, outputs } = inspect(pset)
    const carryIssuance = inputs[2].issuance
    expect(inputs[2].prevout).toBe(outpointOf(coins.collateral.coin))
    expect(carryIssuance?.amount).toBe(CARRY_SUPPLY)
    expect(carryIssuance?.inflationKeys ?? 0n).toBe(0n)
    const supply = outputs[CREATION_OUTPUT.carrySupply]
    expect(supply).toMatchObject({
      asset: carryIssuance?.assetId,
      amount: CARRY_SUPPLY,
      blindingKey: null,
      assetCommitment: null,
      amountCommitment: null,
    })
    // the borrower's self-check, then the lender's gate: the bounds and the addresses
    const { summary, finalizedTx } = await finalize(pset)
    expect(summary.carryAsset).toBe(carryIssuance?.assetId)
    const hex = finalizedTx.toString()
    const asLender = await openAndVerifyOffer(deps, 'lender', keys.lender, hex)
    // the supply's lock is the principal's asset_auth, which the borrower NFT unlocks
    expect(creationCarrySupply(deps, asLender)).toEqual({
      outpoint: `${finalizedTx.txid().toString()}:${CREATION_OUTPUT.carrySupply}`,
      asset: summary.carryAsset,
      amount: CARRY_SUPPLY,
    })
    asLender.opened.free()
  })

  it("refuses one more of either bound, before anything is fetched: the borrower's flow", async () => {
    for (const [collateral, repayment] of [
      [(1n << 44n) + 1n, 1_000n],
      [1_000n, (1n << 50n) - 1n],
    ]) {
      const { built, fetched } = await buildCreation(collateral, repayment)
      await expect(built).rejects.toThrow(/The lender would refuse this offer/)
      expect(fetched).toEqual([])
    }
  })

  it('names the bound an offer breaks, and nothing within them', () => {
    expect(offerBoundsError(wasm, 1n << 44n, (1n << 50n) - 2n)).toBeUndefined()
    expect(offerBoundsError(wasm, 1n, 1n)).toBeUndefined()
    for (const [collateral, repayment] of [
      [(1n << 44n) + 1n, 1n],
      [1n, (1n << 50n) - 1n],
      [0n, 1n],
      [1n, 0n],
    ]) {
      expect(offerBoundsError(wasm, collateral, repayment)).toEqual(expect.any(String))
    }
  })

  // The wasm's `openCreationAsLender` refuses an offer outside the bounds already, so one cannot
  // reach the gate: the gate's own check is run on a stand-in of an opened offer.
  it("refuses one more of either bound at the lender's gate", () => {
    const opened = (collateral: bigint, repayment: bigint) => ({
      checkOfferBounds: () => {},
      collateralAmount: () => collateral,
      repaymentAmount: () => repayment,
    })
    expect(() => checkLenderBounds(wasm, opened(1n << 44n, (1n << 50n) - 2n))).not.toThrow()
    for (const [collateral, repayment] of [
      [(1n << 44n) + 1n, 1_000n],
      [1_000n, (1n << 50n) - 1n],
    ]) {
      let refusal: unknown
      try {
        checkLenderBounds(wasm, opened(collateral, repayment))
      } catch (error) {
        refusal = error
      }
      expect(refusal).toBeInstanceOf(PrivateOfferError)
      expect(refusal).toMatchObject({ code: 'out-of-bounds', addressedToKey: true })
    }
    // and the offer's own check, which the gate runs first
    const refusing = {
      ...opened(1_000n, 1_000n),
      checkOfferBounds: () => {
        throw 'out-of-bounds: the collateral is above 2^44'
      },
    }
    expect(() => checkLenderBounds(wasm, refusing)).toThrow(PrivateOfferError)
  })

  it("wraps a failure of the offer's arguments as an offer error", async () => {
    const throwing = {
      ...wasm,
      openCreationAsLender: (key: Parameters<typeof wasm.openCreationAsLender>[0], hex: string) =>
        new Proxy(wasm.openCreationAsLender(key, hex), {
          get(target, property) {
            if (property === 'contractArguments') {
              return () => {
                throw 'bad-input: the tree could not be built'
              }
            }
            const value: unknown = Reflect.get(target, property)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }),
    }
    const { deps } = fakeChain()
    Object.assign(deps, { wasm: throwing })
    const refusal = await openAndVerifyOffer(
      deps,
      'lender',
      keys.lender,
      fixture.creation_tx,
    ).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(PrivateOfferError)
    expect(refusal).toMatchObject({ code: 'bad-input', addressedToKey: true })
  })

  it("reads the carry token the fixture's creation issues at input 2", async () => {
    const offer = await openOffer('borrower')
    const issuance = newIssuance(fixture.creation_tx, 2)
    expect(issuance?.amount).toBe(CARRY_SUPPLY)
    expect(newIssuance(fixture.creation_tx, 3)).toBeUndefined()
    expect(creationCarrySupply(fakeChain().deps, offer)).toEqual({
      outpoint: `${creationTxid}:${CREATION_OUTPUT.carrySupply}`,
      asset: fixture.carry_asset_id,
      amount: CARRY_SUPPLY,
    })
  })
})

describe('the cancellation of proportional release', () => {
  it('spends the carry supply after the borrower NFT and burns it, explicit, with the NFTs', async () => {
    const offer = await openOffer('borrower')
    const fee = walletCoin(OTHER_ASSET, 100_000n)
    const { deps } = buildingDeps([fee.tx])
    const built = await buildPrivateCancellation(deps, offer, {
      borrowerNftOutpoint: `${creationTxid}:0`,
      feeCoins: [fee.coin],
      collateralReceiver: unsigningWollet.address(2).address(),
    })
    const { inputs, outputs } = inspect(built.pset)
    expect(inputs.map(input => input.prevout)).toEqual([
      `${creationTxid}:3`,
      `${creationTxid}:1`,
      `${creationTxid}:0`,
      `${creationTxid}:${CREATION_OUTPUT.carrySupply}`,
      outpointOf(fee.coin),
    ])
    expect(outputs[CANCELLATION_OUTPUT.carryBurn]).toMatchObject({
      script: '6a046275726e',
      asset: fixture.carry_asset_id,
      amount: CARRY_SUPPLY,
      blindingKey: null,
      amountCommitment: null,
    })
    expect(outputs[CANCELLATION_OUTPUT.collateral].asset).toBe(offer.opened.collateralAsset())
    // the offer's program, the lender NFT lock and the supply's asset_auth (with the borrower
    // NFT's burn at output 1) all run on the built transaction; only the wallet's inputs are left
    expect(() => built.finalize(built.pset)).toThrow('The cancellation: input 2 is not finalized')
  })
})

describe('the installments of proportional release', () => {
  async function atAcceptance() {
    const offer = await openOffer('borrower')
    const claim = principalClaim(offer)
    const loan = await borrowerLoan(offer, `${acceptanceTxid}:0`)
    return { offer, claim, loan }
  }

  it('spends the principal coins, then the carry supply, and burns its leftover at the first', async () => {
    const { offer, claim, loan } = await atAcceptance()
    const { some } = amountsByRelease(loan.state)
    const release = loan.state.releasePreview(some)
    const { built, principal, fee } = await buildInstallment({
      offer,
      loan,
      claim,
      chain: [],
      amount: some,
    })
    const { inputs, outputs } = inspect(built.pset)
    expect(inputs.map(input => input.prevout)).toEqual([
      `${txidOf(claim)}:0`,
      `${acceptanceTxid}:0`,
      outpointOf(principal.coin),
      `${creationTxid}:${CREATION_OUTPUT.carrySupply}`,
      outpointOf(fee.coin),
    ])
    const collateral = offer.opened.collateralAmount()
    const repayment = offer.opened.repaymentAmount()
    expect(outputs[INSTALLMENT_OUTPUT.loan]).toMatchObject({
      asset: offer.opened.collateralAsset(),
      amount: collateral - release,
    })
    expect(outputs[INSTALLMENT_OUTPUT.installment].amount).toBe(some)
    const carries = [outputs[INSTALLMENT_OUTPUT.carry], outputs[INSTALLMENT_OUTPUT.secondCarry]]
    expect(carries.every(carry => carry.asset === fixture.carry_asset_id)).toBe(true)
    expect(carries.reduce((sum, carry) => sum + (carry.amount ?? 0n), 0n)).toBe(repayment + 1n)
    expect(carries.every(carry => carry.blindingKey === offer.opened.borrowerBlindingKey())).toBe(
      true,
    )
    expect(outputs[INSTALLMENT_OUTPUT.release]).toMatchObject({
      asset: offer.opened.collateralAsset(),
      amount: release,
    })
    expect(outputs[INSTALLMENT_OUTPUT.leftoverBurn]).toMatchObject({
      script: '6a046275726e',
      asset: fixture.carry_asset_id,
      amount: CARRY_SUPPLY - repayment - 1n,
      blindingKey: offer.opened.borrowerBlindingKey(),
    })
    expect(outputs[INSTALLMENT_OUTPUT.leftoverBurn].amountCommitment).not.toBeNull()
    // the installment program, with the release proof, and the supply's asset_auth run on it
    expect(() => built.finalize(built.pset)).toThrow('The installment: input 0 is not finalized')
  })

  // Proofs, R2: whether the installment released collateral does not show in its output count.
  it('gives the borrower one more confidential output when it releases nothing', async () => {
    const { offer, claim, loan } = await atAcceptance()
    const { none, some } = amountsByRelease(loan.state)
    const releasing = await buildInstallment({ offer, loan, claim, chain: [], amount: some })
    const nothing = await buildInstallment({ offer, loan, claim, chain: [], amount: none })
    const releasingOutputs = inspect(releasing.built.pset).outputs
    const nothingOutputs = inspect(nothing.built.pset).outputs
    expect(nothingOutputs.length).toBe(releasingOutputs.length)
    expect(nothingOutputs[INSTALLMENT_OUTPUT.release]).toMatchObject({
      asset: OTHER_ASSET,
      amount: R2_EXTRA_OUTPUT_AMOUNT,
    })
    for (const outputs of [releasingOutputs, nothingOutputs]) {
      const output = outputs[INSTALLMENT_OUTPUT.release]
      expect(output.blindingKey).not.toBeNull()
      expect(output.amountCommitment).not.toBeNull()
      expect(output.script.slice(0, 4)).toBe('0014')
    }
    expect(nothingOutputs[INSTALLMENT_OUTPUT.loan].amount).toBe(offer.opened.collateralAmount())
    expect(() => nothing.built.finalize(nothing.built.pset)).toThrow(
      'The installment: input 0 is not finalized',
    )
  })

  // Proofs, O10: the burns carry the range proof of every other confidential output.
  it('burns with the range-proof parameters of the other confidential outputs', async () => {
    const { offer, claim, loan } = await atAcceptance()
    const { some } = amountsByRelease(loan.state)
    const { tx } = await buildInstallment({ offer, loan, claim, chain: [], amount: some })
    const proofs = outputRangeProofs(tx)
    const confidential = proofs.filter(proof => proof.length > 0)
    const burn = proofs[INSTALLMENT_OUTPUT.leftoverBurn]
    // successor, installment, carries, release, burn, principal change, policy change
    expect(confidential.length).toBeGreaterThanOrEqual(7)
    for (const proof of confidential) {
      expect(proof.length).toBe(burn.length)
      // the header: the control byte, the exponent and mantissa, the minimum value
      expect([...proof.subarray(0, 10)]).toEqual([...burn.subarray(0, 10)])
    }
  })

  // Proofs, O7: outputs 1 to 4 are blinded with exactly the plan's blinders.
  it('refuses a build whose carry is not blinded with the plan', async () => {
    const { offer, claim, loan } = await atAcceptance()
    const dropFirstCarry: Partial<PrivateFlowDeps['wasm']> = {
      blindPset: (pset, secrets, blindings) =>
        wasm.blindPset(
          pset,
          secrets,
          blindings.filter((blinding, index) => {
            if (index !== 2) return true
            blinding.free()
            return false
          }),
        ),
    }
    await expect(
      buildInstallment({
        offer,
        loan,
        claim,
        chain: [],
        amount: 100n,
        wasmOverride: dropFirstCarry,
      }),
    ).rejects.toThrow('Installment PSET after blinding: output 3 is not blinded to its pinned')
  })

  // Review focus 4: the indexer names the carries, and the chain decides.
  it('spends only the carries the loan opens on chain, whatever the indexer names', async () => {
    const { offer, claim, loan } = await atAcceptance()
    const supply = `${creationTxid}:${CREATION_OUTPUT.carrySupply}`
    for (const [named, refused] of [
      [[`${creationTxid}:3`], 'The indexer names'],
      [[supply, `${installmentTxid}:3`], 'The indexer names'],
      [[], "does not list the loan's carry"],
    ] as const) {
      await expect(
        buildInstallment({
          offer,
          loan,
          claim,
          chain: [],
          amount: 100n,
          carryOutpoints: [...named],
        }),
      ).rejects.toThrow(refused)
    }
  })

  it('spends the two carries of the last installment, after the principal coins', async () => {
    const { offer, claim, loan } = await atAcceptance()
    const first = await buildInstallment({ offer, loan, claim, chain: [], amount: 2_000n })
    const next = await borrowerLoan(offer, `${first.txid}:1`, [first.hex])
    expect(chainCarries(next)).toEqual([`${first.txid}:3`, `${first.txid}:4`])
    // the indexer's view of the fixture's other installment's carries is refused
    await expect(
      buildInstallment({
        offer,
        loan: next,
        claim,
        chain: [first.hex],
        amount: 1_000n,
        carryOutpoints: [`${installmentTxid}:3`, `${installmentTxid}:4`],
      }),
    ).rejects.toThrow('The indexer names')
    const { none, some } = amountsByRelease(next.state)
    for (const amount of [none, some]) {
      const steady = await buildInstallment({
        offer,
        loan: next,
        claim,
        chain: [first.hex],
        amount,
      })
      const { inputs, outputs } = inspect(steady.built.pset)
      expect(inputs.slice(2).map(input => input.prevout)).toEqual([
        outpointOf(steady.principal.coin),
        `${first.txid}:3`,
        `${first.txid}:4`,
        outpointOf(steady.fee.coin),
      ])
      // no leftover after the first: two carries in, two out, R + 1 units each way
      expect(outputs[INSTALLMENT_OUTPUT.leftoverBurn].script).not.toBe('6a046275726e')
      expect(
        outputs.filter(output => output.script === '6a046275726e' && output.asset !== null),
      ).toEqual([])
      expect(() => steady.built.finalize(steady.built.pset)).toThrow(
        'The installment: input 0 is not finalized',
      )
    }
  })

  // Proofs, O11 and L1: a rebuild of one loan state pays the same amount from a fresh input 2,
  // which keeps output 2's key fresh, and a carry is never input 2.
  it('rebuilds a loan state only with the same amount and a first wallet input no build used', async () => {
    const { offer, claim, loan } = await atAcceptance()
    const coin = walletCoin(offer.opened.principalAsset(), 5_000n)
    const first = await buildInstallment({
      offer,
      loan,
      claim,
      chain: [],
      amount: 700n,
      principal: coin,
    })
    const firstKey = inspect(first.built.pset).outputs[INSTALLMENT_OUTPUT.installment].ecdhPubkey
    // the same amount and the same first wallet input: refused
    await expect(
      buildInstallment({
        offer,
        loan,
        claim,
        chain: [],
        amount: 700n,
        principal: coin,
        earlierBuilds: [first.hex],
      }),
    ).rejects.toThrow(`started from the coin ${outpointOf(coin.coin)}`)
    // another amount: refused, whatever the input
    await expect(
      buildInstallment({ offer, loan, claim, chain: [], amount: 701n, earlierBuilds: [first.hex] }),
    ).rejects.toThrow('paid 700 base units')
    // the same amount from another coin: built, with another output-2 key
    const rebuilt = await buildInstallment({
      offer,
      loan,
      claim,
      chain: [],
      amount: 700n,
      earlierBuilds: [first.hex],
    })
    const rebuiltKey = inspect(rebuilt.built.pset).outputs[INSTALLMENT_OUTPUT.installment]
      .ecdhPubkey
    expect(rebuiltKey).not.toBeNull()
    expect(rebuiltKey).not.toBe(firstKey)
    // the successor is the same point: only the link between the two builds leaks
    expect(inspect(rebuilt.built.pset).outputs[INSTALLMENT_OUTPUT.loan].amountCommitment).toBe(
      inspect(first.built.pset).outputs[INSTALLMENT_OUTPUT.loan].amountCommitment,
    )
    for (const build of [first, rebuilt]) {
      const { inputs } = inspect(build.built.pset)
      expect(inputs[2].prevout).toBe(outpointOf(build.principal.coin))
      expect(inputs[2].prevout).not.toBe(`${creationTxid}:${CREATION_OUTPUT.carrySupply}`)
    }
    // the fixture's installment of 3,000 spends this loan output too: it reads back, and binds
    await expect(
      buildInstallment({
        offer,
        loan,
        claim,
        chain: [],
        amount: 900n,
        earlierBuilds: [installmentHex],
      }),
    ).rejects.toThrow('paid 3000 base units')
    // a build of another loan state is not one of the next state's
    const next = await borrowerLoan(offer, `${first.txid}:1`, [first.hex])
    await expect(
      buildInstallment({
        offer,
        loan: next,
        claim,
        chain: [first.hex],
        amount: 900n,
        earlierBuilds: [first.hex, rebuilt.hex],
      }),
    ).resolves.toBeDefined()
  })

  it('refuses an installment of the whole debt, which the full repayment pays', async () => {
    const { offer, claim, loan } = await atAcceptance()
    await expect(
      buildInstallment({ offer, loan, claim, chain: [], amount: loan.state.remaining ?? 0n }),
    ).rejects.toThrow('less than the')
  })

  it('refuses an installment at step 1024, before anything is fetched', async () => {
    const { offer, claim, loan } = await atAcceptance()
    const atLimit = {
      ...loan,
      state: new Proxy(loan.state, {
        get(target, property) {
          if (property === 'installmentCount') return 1024
          const value: unknown = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }),
    }
    const { deps, fetched } = buildingDeps([claim])
    await expect(
      buildPrivateInstallment(deps, offer, atLimit, {
        amount: 100n,
        borrowerNftOutpoint: `${txidOf(claim)}:0`,
        principalCoins: [walletCoin(offer.opened.principalAsset(), 5_000n).coin],
        feeCoins: [walletCoin(OTHER_ASSET, 100_000n).coin],
        carryOutpoints: [],
        earlierBuilds: [],
        lendingKey: keys.borrower,
        tipHeight: offer.opened.loanExpirationTime() - 10,
      }),
    ).rejects.toThrow('1,024 installments')
    expect(fetched).toEqual([])
  })
})

describe('the full repayment of proportional release', () => {
  async function repay(offer: VerifiedOffer, loan: Loan, claim: string, chain: string[]) {
    const owed = loan.state.remaining ?? 0n
    const principal = walletCoin(offer.opened.principalAsset(), owed + 500n)
    const fee = walletCoin(OTHER_ASSET, 100_000n)
    const { deps } = buildingDeps([...chain, claim, principal.tx, fee.tx])
    const built = await buildPrivateRepayment(deps, offer, loan, {
      borrowerNftOutpoint: `${txidOf(claim)}:0`,
      principalCoins: [principal.coin],
      feeCoins: [fee.coin],
      carryOutpoints: chainCarries(loan),
      collateralReceiver: unsigningWollet.address(3).address(),
      lendingKey: keys.borrower,
    })
    return { built, principal, fee }
  }

  it('sweeps the carry supply before any installment, and the two carries after one', async () => {
    const offer = await openOffer('borrower')
    const claim = principalClaim(offer)
    const atAcceptance = await borrowerLoan(offer, `${acceptanceTxid}:0`)
    const repayment = offer.opened.repaymentAmount()

    const early = await repay(offer, atAcceptance, claim, [])
    const earlyPset = inspect(early.built.pset)
    expect(earlyPset.inputs.slice(2).map(input => input.prevout)).toEqual([
      outpointOf(early.principal.coin),
      `${creationTxid}:${CREATION_OUTPUT.carrySupply}`,
      outpointOf(early.fee.coin),
    ])
    expect(earlyPset.outputs[REPAYMENT_OUTPUT.collateral].amount).toBe(
      offer.opened.collateralAmount(),
    )
    expect(earlyPset.outputs[REPAYMENT_OUTPUT.carryBurn]).toMatchObject({
      script: '6a046275726e',
      asset: fixture.carry_asset_id,
      amount: CARRY_SUPPLY,
      blindingKey: offer.opened.borrowerBlindingKey(),
    })
    expect(earlyPset.outputs[REPAYMENT_OUTPUT.carryBurn].amountCommitment).not.toBeNull()
    // the repayment's program and the supply's asset_auth, with the NFT's burn at output 0
    expect(() => early.built.finalize(early.built.pset)).toThrow(
      'The repayment: input 0 is not finalized',
    )

    const first = await buildInstallment({
      offer,
      loan: atAcceptance,
      claim,
      chain: [],
      amount: 2_000n,
    })
    const after = await borrowerLoan(offer, `${first.txid}:1`, [first.hex])
    const late = await repay(offer, after, claim, [first.hex])
    const latePset = inspect(late.built.pset)
    expect(latePset.inputs.slice(3, 5).map(input => input.prevout)).toEqual([
      `${first.txid}:3`,
      `${first.txid}:4`,
    ])
    // the collateral the installment left, and every carry unit burned
    expect(latePset.outputs[REPAYMENT_OUTPUT.collateral].amount).toBe(
      offer.opened.collateralAmount() - atAcceptance.state.releasePreview(2_000n),
    )
    expect(latePset.outputs[REPAYMENT_OUTPUT.carryBurn].amount).toBe(repayment + 1n)
    expect(() => late.built.finalize(late.built.pset)).toThrow(
      'The repayment: input 0 is not finalized',
    )
    // the burn's range proof is the other outputs' too (O10)
    const proofs = outputRangeProofs(late.built.pset.extractTx()).filter(proof => proof.length > 0)
    expect(new Set(proofs.map(proof => proof.length)).size).toBe(1)
  })
})

describe('the liquidation of proportional release', () => {
  // Review focus 1: the lender takes the collateral's opening from the search when an
  // installment does not open for it. The stand-in state hides the collateral the lender reads,
  // as an unreadable installment would, until the search's result is set; the wasm's own tests
  // build the unreadable installment itself.
  it('takes the collateral from the search when an installment does not open', async () => {
    const borrower = await openOffer('borrower')
    const claim = principalClaim(borrower)
    const atAcceptance = await borrowerLoan(borrower, `${acceptanceTxid}:0`)
    const first = await buildInstallment({
      offer: borrower,
      loan: atAcceptance,
      claim,
      chain: [],
      amount: 2_000n,
    })
    const held = borrower.opened.collateralAmount() - atAcceptance.state.releasePreview(2_000n)

    const lender = await openOffer('lender')
    const fee = walletCoin(OTHER_ASSET, 100_000n)
    const { deps } = buildingDeps([first.hex, fee.tx])
    const loan = await loadLoan(deps, lender, keys.lender, `${first.txid}:1`)
    let found = false
    const hidden = new Proxy(loan.state, {
      get(target, property) {
        if (property === 'collateral') return () => (found ? target.collateral() : undefined)
        if (property === 'setCollateral') {
          return (amount: bigint) => {
            target.setCollateral(amount)
            found = true
          }
        }
        const value: unknown = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const searches: bigint[] = []
    const search: CollateralFinder = async input => {
      const amount = wasm.findCollateral(
        input.valueCommitment,
        input.assetCommitment,
        input.blinder,
        input.max,
      )
      if (amount !== undefined) searches.push(amount)
      return amount
    }
    const built = await buildPrivateLiquidation(
      deps,
      lender,
      { ...loan, state: hidden },
      {
        lenderNftOutpoint: `${acceptanceTxid}:2`,
        unspentInstallments: [`${first.txid}:2`],
        feeCoins: [fee.coin],
        collateralReceiver: unsigningWollet.address(4).address(),
        tipHeight: lender.opened.loanExpirationTime(),
        findCollateral: search,
      },
    )
    expect(searches).toEqual([held])
    expect(inspect(built.pset).outputs[1]).toMatchObject({
      asset: lender.opened.collateralAsset(),
      amount: held,
    })
    // the liquidation program runs on the loan input opened with the search's result
    expect(() => built.finalize(built.pset)).toThrow(/input 1 is not finalized/)

    // without a search, an unreadable installment stops the liquidation
    found = false
    await expect(
      buildPrivateLiquidation(
        deps,
        lender,
        { ...loan, state: hidden },
        {
          lenderNftOutpoint: `${acceptanceTxid}:2`,
          unspentInstallments: [`${first.txid}:2`],
          feeCoins: [fee.coin],
          collateralReceiver: unsigningWollet.address(4).address(),
          tipHeight: lender.opened.loanExpirationTime(),
        },
      ),
    ).rejects.toThrow('no search was given')
  })
})

describe('the weights of the installment', () => {
  // The fee is estimated with `maxWeightToSatisfy`: it covers the script witness of a real
  // installment of this program, and of the acceptance.
  it("covers the script witness of the fixture's transactions", () => {
    const installment = scriptWitnessWeight(installmentHex, 1)
    expect(installment).toBeGreaterThan(8_000)
    expect(installment).toBeLessThanOrEqual(PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.Installment)
    // with the margin the other weights keep
    expect(PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.Installment).toBeGreaterThanOrEqual(
      Math.ceil(installment * 1.08),
    )
    const acceptance = scriptWitnessWeight(fixture.loan.acceptance_tx, 0)
    expect(acceptance).toBeLessThanOrEqual(PRIVATE_LENDING_MAX_WEIGHT_TO_SATISFY.OfferAcceptance)
  })
})
