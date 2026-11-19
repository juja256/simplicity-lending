import fs from 'node:fs'

import type { Address, WalletTxOut } from 'lwk_wasm'
import { describe, expect, it } from 'vitest'

import { lwk, sources } from '@/test/lwk'
import { wasm } from '@/test/wasm'
import type { LoanState } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from './deps'
import { pinnedAuthCovenant } from './finalize'
import { buildInstallmentClaim } from './flows/claimInstallments'
import { buildFinalClaim, NothingToClaimError } from './flows/claimRepayment'
import { buildPrivateInstallment } from './flows/installment'
import { buildPrivateLiquidation, ExpiryNotReachedError } from './flows/liquidation'
import { buildPrivateRepayment } from './flows/repayment'
import { buildZeroDebtClose } from './flows/zeroDebtClose'
import { loadLoan, type Loan, principalClaimedBefore, PrincipalNotClaimedError } from './loan'
import { openAndVerifyOffer, type VerifiedOffer } from './verify'

// The parity fixture's offer and its loan on regtest: the acceptance, then one installment, which
// takes the borrower NFT from the creation's output 0 (the principal is never claimed).
interface Fixture {
  borrower_master_blinding_key: string
  lender_master_blinding_key: string
  creation_tx: string
  installment_output_script_hash: string
  loan: {
    acceptance_tx: string
    installment_txs: string[]
    loan_outpoint: string
    remaining: number
    debt_hashes: string[]
    loan_script_pubkeys: string[]
  }
  other_offer: { creation_tx: string }
}

const fixture = JSON.parse(
  fs.readFileSync(
    new URL('../../scripts/fixtures/private-lending-parity.json', import.meta.url),
    'utf-8',
  ),
) as Fixture

const txidOf = (hex: string) => lwk.Transaction.fromString(hex).txid().toString()
const creationTxid = txidOf(fixture.creation_tx)
const acceptanceTxid = txidOf(fixture.loan.acceptance_tx)
const installmentHex = fixture.loan.installment_txs[0]
const installmentTxid = txidOf(installmentHex)
const installmentLock = lwk.Transaction.fromString(installmentHex)
  .outputs[2].scriptPubkey()
  .toString()

/** The fixture's transactions, and the ones a test adds, served by txid as esplora would. */
function fakeChain(...extra: string[]): { deps: PrivateFlowDeps; fetched: string[] } {
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

const keys = {
  borrower: wasm.LendingKey.fromMasterBlindingKey(fixture.borrower_master_blinding_key),
  lender: wasm.LendingKey.fromMasterBlindingKey(fixture.lender_master_blinding_key),
}

function openOffer(
  role: 'borrower' | 'lender',
  creationTx = fixture.creation_tx,
): Promise<VerifiedOffer> {
  return openAndVerifyOffer(fakeChain().deps, role, keys[role], creationTx)
}

const reversed = (hex: string) => (hex.match(/../g) ?? []).reverse().join('')
const u32le = (n: number) => reversed(n.toString(16).padStart(8, '0'))
const u64be = (n: bigint) => n.toString(16).padStart(16, '0')
const pushLength = (hex: string) => (hex.length / 2).toString(16).padStart(2, '0')

/** Any asset that is not one of the offer's NFTs. */
const OTHER_ASSET = '5ac9f65c0efcc4775e0baec4ec03abdde22473cd3cf33c0419ca290e0751b225'
const WALLET_SCRIPT = '0014' + '71'.repeat(20)
/** `OP_RETURN "burn"`, as the flows burn an NFT. */
const BURN_SCRIPT = '6a04' + Buffer.from('burn').toString('hex')

interface StandInOutput {
  script: string
  /** The explicit asset, as `AssetId.toString()` shows it. */
  asset?: string
  value?: bigint
}

/**
 * A transaction that only stands in for a real one: explicit outputs and no witnesses, enough for
 * the walks, which read the outpoints its inputs spend and its outputs' scripts and assets.
 */
function standIn(inputs: string[], outputs: StandInOutput[]): string {
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

/**
 * The acceptance with input 0 spending another outpoint than the pending offer: its outputs, the
 * active collateral at output 0 and the principal lock at output 1, are the real ones.
 */
const forgedAcceptance = (() => {
  const acceptance = fixture.loan.acceptance_tx
  // version, segwit flag, one input count byte, then input 0's prevout txid
  if (acceptance.slice(12, 76) !== reversed(creationTxid)) throw new Error('unexpected layout')
  return acceptance.slice(0, 12) + reversed('ab'.repeat(32)) + acceptance.slice(76)
})()

/** `hex` with its one occurrence of `from` replaced by `to`. */
function replaceOnce(hex: string, from: string, to: string): string {
  const at = hex.indexOf(from)
  if (at < 0 || hex.indexOf(from, at + 1) >= 0) throw new Error('not exactly one occurrence')
  return hex.slice(0, at) + to + hex.slice(at + from.length)
}

describe('principalClaimedBefore', () => {
  /** The borrower NFT, explicit, at output 0 of the stand-ins that hold it. */
  async function nftOutput(): Promise<StandInOutput> {
    const offer = await openOffer('borrower')
    return { script: WALLET_SCRIPT, asset: offer.opened.borrowerNft(), value: 1n }
  }

  /** The principal claim, then two installments, each taking the borrower NFT from output 0. */
  async function claimedChain() {
    const nft = await nftOutput()
    const claim = standIn(
      [`${acceptanceTxid}:1`, `${creationTxid}:0`],
      [nft, { script: WALLET_SCRIPT }],
    )
    const first = standIn(
      [`${txidOf(claim)}:0`, `${acceptanceTxid}:0`, `${txidOf(claim)}:1`],
      [nft, { script: WALLET_SCRIPT }, { script: installmentLock }],
    )
    const second = standIn(
      [`${txidOf(first)}:0`, `${txidOf(first)}:1`],
      [nft, { script: WALLET_SCRIPT }, { script: installmentLock }],
    )
    return { claim, first, second }
  }

  it('holds through two installments after the claim', async () => {
    const offer = await openOffer('borrower')
    const { claim, first, second } = await claimedChain()
    const { deps } = fakeChain(claim, first, second)
    for (const tx of [claim, first, second]) {
      await expect(principalClaimedBefore(deps, offer, `${txidOf(tx)}:0`)).resolves.toBe(true)
    }
  })

  it('fails when the walk reaches the creation', async () => {
    const offer = await openOffer('borrower')
    const nft = await nftOutput()
    // the fixture's installment takes the borrower NFT from the creation's output 0
    const { deps } = fakeChain()
    await expect(principalClaimedBefore(deps, offer, `${installmentTxid}:0`)).resolves.toBe(false)
    await expect(principalClaimedBefore(deps, offer, `${creationTxid}:0`)).resolves.toBe(false)
    // and so does an installment after it
    const second = standIn(
      [`${installmentTxid}:0`, `${installmentTxid}:1`],
      [nft, { script: WALLET_SCRIPT }, { script: installmentLock }],
    )
    const withSecond = fakeChain(second).deps
    await expect(principalClaimedBefore(withSecond, offer, `${txidOf(second)}:0`)).resolves.toBe(
      false,
    )
  })

  it('fails for an outpoint other than output 0', async () => {
    const offer = await openOffer('borrower')
    const { claim, first, second } = await claimedChain()
    const { deps } = fakeChain(claim, first, second)
    for (const outpoint of [`${txidOf(claim)}:1`, `${txidOf(second)}:1`, `${txidOf(second)}:2`]) {
      await expect(principalClaimedBefore(deps, offer, outpoint)).resolves.toBe(false)
    }
  })

  it('fails at the burned borrower NFT of a repayment', async () => {
    const offer = await openOffer('borrower')
    const { claim, first, second } = await claimedChain()
    const nft = await nftOutput()
    const repayment = standIn(
      [`${txidOf(second)}:0`, `${txidOf(second)}:1`],
      [{ ...nft, script: BURN_SCRIPT }, { script: WALLET_SCRIPT }, { script: WALLET_SCRIPT }],
    )
    // a claim of the principal that burns the NFT: the principal lock takes a burn as its output
    const burningClaim = standIn(
      [`${acceptanceTxid}:1`, `${creationTxid}:0`],
      [{ ...nft, script: BURN_SCRIPT }, { script: WALLET_SCRIPT }],
    )
    const { deps } = fakeChain(claim, first, second, repayment, burningClaim)
    for (const tx of [repayment, burningClaim]) {
      await expect(principalClaimedBefore(deps, offer, `${txidOf(tx)}:0`)).resolves.toBe(false)
    }
  })

  it("fails for a claim of an output 1 that is not the offer's principal", async () => {
    const offer = await openOffer('borrower')
    const nft = await nftOutput()
    // the creation's output 1 is the lender NFT lock; the forged acceptance's is the principal
    // lock, but it does not spend the pending offer
    const claims = [`${creationTxid}:1`, `${txidOf(forgedAcceptance)}:1`].map(principal =>
      standIn([principal, `${creationTxid}:0`], [nft]),
    )
    const { deps } = fakeChain(forgedAcceptance, ...claims)
    for (const claim of claims) {
      await expect(principalClaimedBefore(deps, offer, `${txidOf(claim)}:0`)).resolves.toBe(false)
    }
  })
})

describe('loadLoan', () => {
  it("reads the parity fixture's installment for either party", async () => {
    for (const role of ['borrower', 'lender'] as const) {
      const offer = await openOffer(role)
      const loan = await loadLoan(fakeChain().deps, offer, keys[role], fixture.loan.loan_outpoint)
      expect(loan.state.debtHash).toBe(fixture.loan.debt_hashes[1])
      expect(loan.state.loanOutpoint).toBe(fixture.loan.loan_outpoint)
      expect(loan.state.remaining).toBe(BigInt(fixture.loan.remaining))
      expect(loan.acceptanceTxid).toBe(acceptanceTxid)
      expect(loan.installmentTxids).toEqual([installmentTxid])
    }
  })

  it('reads a loan at its acceptance', async () => {
    const offer = await openOffer('borrower')
    const loan = await loadLoan(fakeChain().deps, offer, keys.borrower, `${acceptanceTxid}:0`)
    expect(loan.state.installmentCount).toBe(0)
    expect(loan.state.debtHash).toBe(fixture.loan.debt_hashes[0])
    expect(loan.installmentTxids).toEqual([])
  })

  it('refuses a loan outpoint whose script is not the active offer at its debt', async () => {
    const offer = await openOffer('borrower')
    // the installment, with its loan output at the loan's script of the debt before it
    const [before, after] = fixture.loan.loan_script_pubkeys
    const moved = replaceOnce(installmentHex, after, before)
    // the wasm checks the commitments, not the scripts
    expect(
      offer.opened.loanState(keys.borrower, fixture.loan.acceptance_tx, [moved]).debtHash,
    ).toBe(fixture.loan.debt_hashes[1])
    const { deps } = fakeChain(moved)
    await expect(loadLoan(deps, offer, keys.borrower, `${txidOf(moved)}:1`)).rejects.toThrow(
      `Loan output 1 (${txidOf(moved)}:1) is not locked to the loan's script at its debt`,
    )
  })

  it("refuses a chain that does not lead back to the offer's acceptance", async () => {
    const offer = await openOffer('borrower')
    const forgedTxid = txidOf(forgedAcceptance)
    const forged = forgedAcceptance
    // its output 0 is still the active collateral, which is all the wasm checks of it
    expect(offer.opened.loanState(keys.borrower, forged, []).installmentCount).toBe(0)
    // and an installment that spends it
    const installment = replaceOnce(installmentHex, reversed(acceptanceTxid), reversed(forgedTxid))
    const { deps } = fakeChain(forged, installment)
    for (const outpoint of [`${forgedTxid}:0`, `${txidOf(installment)}:1`]) {
      await expect(loadLoan(deps, offer, keys.borrower, outpoint)).rejects.toThrow(
        `${forgedTxid} is neither this offer's acceptance nor one of its installments`,
      )
    }
  })

  it("refuses another offer's loan", async () => {
    const other = await openOffer('borrower', fixture.other_offer.creation_tx)
    const { deps } = fakeChain()
    await expect(loadLoan(deps, other, keys.borrower, fixture.loan.loan_outpoint)).rejects.toThrow(
      `${installmentTxid} is neither`,
    )
    await expect(loadLoan(deps, other, keys.borrower, `${acceptanceTxid}:0`)).rejects.toThrow(
      `${acceptanceTxid} is neither`,
    )
  })

  it('refuses an outpoint that is not a loan output', async () => {
    const offer = await openOffer('borrower')
    const { deps } = fakeChain()
    await expect(loadLoan(deps, offer, keys.borrower, `${installmentTxid}:2`)).rejects.toThrow(
      `${installmentTxid}:2 is not the loan output of the installment ${installmentTxid}`,
    )
    await expect(loadLoan(deps, offer, keys.borrower, `${acceptanceTxid}:1`)).rejects.toThrow(
      `${acceptanceTxid}:1 is not the loan output of the acceptance ${acceptanceTxid}`,
    )
  })
})

describe("the borrower's flows", () => {
  /** A wallet coin of `asset`, explicit, as the flows read one. */
  const coin = (outpoint: string, asset: string, value: bigint) =>
    ({
      outpoint: () => new lwk.OutPoint(outpoint),
      unblinded: () => lwk.TxOutSecrets.fromExplicit(lwk.AssetId.fromString(asset), value),
    }) as unknown as WalletTxOut
  const confidential = { isBlinded: () => true } as unknown as Address

  // Review focus 1: the fixture's installment took the borrower NFT from the creation's output 0,
  // so the principal is unclaimed, and the NFT at the installment's output 0 is its only key.
  it('refuse an installment and a full repayment before the principal is claimed', async () => {
    const offer = await openOffer('borrower')
    const { deps: walk } = fakeChain()
    const loan = await loadLoan(walk, offer, keys.borrower, fixture.loan.loan_outpoint)
    const nft = `${installmentTxid}:0`
    const principalCoins = [coin(`${'c1'.repeat(32)}:0`, offer.opened.principalAsset(), 5_000n)]
    const feeCoins = [coin(`${'c2'.repeat(32)}:0`, OTHER_ASSET, 2_000n)]
    const builds = [
      (deps: PrivateFlowDeps) =>
        buildPrivateInstallment(deps, offer, loan, {
          amount: 1_000n,
          borrowerNftOutpoint: nft,
          principalCoins,
          feeCoins,
        }),
      (deps: PrivateFlowDeps) =>
        buildPrivateRepayment(deps, offer, loan, {
          borrowerNftOutpoint: nft,
          principalCoins: [coin(`${'c1'.repeat(32)}:0`, offer.opened.principalAsset(), 8_000n)],
          feeCoins,
          collateralReceiver: confidential,
        }),
    ]
    for (const build of builds) {
      const { deps, fetched } = fakeChain()
      const refusal = await build(deps).catch((error: unknown) => error)
      expect(refusal).toBeInstanceOf(PrincipalNotClaimedError)
      expect((refusal as PrincipalNotClaimedError).borrowerNftOutpoint).toBe(nft)
      // the walk alone: the installment, whose input 0 spends the creation's output 0
      expect(fetched).toEqual([installmentTxid])
    }
  })

  it('refuse a zero-debt close before the principal is claimed', async () => {
    const offer = await openOffer('borrower')
    const { deps: walk } = fakeChain()
    const loan = await loadLoan(walk, offer, keys.borrower, fixture.loan.loan_outpoint)
    // the fixture's loan owes 8 000: a stand-in of its state that owes nothing passes the close's
    // amount check, so the borrower NFT's check is the one that refuses
    const real = loan.state
    const owingNothing = {
      remaining: 0n,
      loanOutpoint: real.loanOutpoint,
      debtHash: real.debtHash,
      debtCommitment: real.debtCommitment,
      collateral: () => real.collateral(),
      zeroDebtKey: () => '11'.repeat(32),
      loanInputSecret: (index: number) => real.loanInputSecret(index),
    } as unknown as LoanState
    const nft = `${installmentTxid}:0`
    const { deps, fetched } = fakeChain()
    const refusal = await buildZeroDebtClose(
      deps,
      offer,
      { ...loan, state: owingNothing },
      {
        borrowerNftOutpoint: nft,
        feeCoins: [coin(`${'c2'.repeat(32)}:0`, OTHER_ASSET, 2_000n)],
        collateralReceiver: confidential,
      },
    ).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(PrincipalNotClaimedError)
    expect((refusal as PrincipalNotClaimedError).borrowerNftOutpoint).toBe(nft)
    expect(fetched).toEqual([installmentTxid])
  })
})

describe("the lender's flows", () => {
  const coin = (outpoint: string, asset: string, value: bigint) =>
    ({
      outpoint: () => new lwk.OutPoint(outpoint),
      unblinded: () => lwk.TxOutSecrets.fromExplicit(lwk.AssetId.fromString(asset), value),
    }) as unknown as WalletTxOut
  const installment = `${installmentTxid}:2`
  const lenderNftAtAcceptance = `${acceptanceTxid}:2`
  // the lender's fee coin, in a transaction of its own, so that the builders find its prevout
  const feeTx = standIn([`${'f0'.repeat(32)}:0`], [{ script: WALLET_SCRIPT, value: 2_000n }])
  const feeCoins = [coin(`${txidOf(feeTx)}:0`, OTHER_ASSET, 2_000n)]

  /** The fake chain's deps, with a wallet that hands out confidential regtest addresses. */
  function lenderChain(offer: VerifiedOffer, ...extra: string[]) {
    const chain = fakeChain(feeTx, ...extra)
    const address = () =>
      lwk.Address.parse(
        wasm.confidentialAddress(WALLET_SCRIPT, offer.opened.lenderBlindingKey(), 'regtest'),
        lwk.Network.regtestDefault(),
      )
    Object.assign(chain.deps, {
      wollet: { maxWeightToSatisfy: () => 150 },
      addresses: {
        nextReceive: address,
        nextChange: (_wollet: unknown, count: number) => Array.from({ length: count }, address),
      },
    })
    return chain
  }

  async function lenderLoan() {
    const offer = await openOffer('lender')
    const loan = await loadLoan(fakeChain().deps, offer, keys.lender, fixture.loan.loan_outpoint)
    return { offer, loan }
  }

  /** `state` with `sweep` replaced. */
  function withSweep(state: LoanState, sweep: () => unknown): LoanState {
    return new Proxy(state, {
      get(target, property) {
        if (property === 'sweep') return sweep
        const value: unknown = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  const emptySweep = () => ({ outpoints: () => [], amount: 0n, free: () => {} })

  /** A claim of the fixture's installment that returns the lender NFT at its output 0. */
  async function installmentClaimTx(offer: VerifiedOffer): Promise<string> {
    return standIn(
      [lenderNftAtAcceptance, installment, `${'f1'.repeat(32)}:0`],
      [
        { script: WALLET_SCRIPT, asset: offer.opened.lenderNft(), value: 1n },
        { script: WALLET_SCRIPT },
      ],
    )
  }

  /**
   * A stand-in full repayment of the fixture's loan: it spends the loan output at input 1, and
   * its output 1 carries `A` and exactly the debt at the repayment lock, which is all the sweep
   * reads of it.
   */
  function fullRepaymentTx(offer: VerifiedOffer, deps: PrivateFlowDeps, loan: Loan): string {
    const lock = pinnedAuthCovenant(deps, offer, 'repayment').script.toString()
    const repayment =
      offer.opened.pinned(wasm.PinnedRole.Repayment).assetCommitment +
      loan.state.debtCommitment +
      '00' +
      pushLength(lock) +
      lock
    const tx = standIn(
      [`${'f2'.repeat(32)}:0`, fixture.loan.loan_outpoint],
      [{ script: BURN_SCRIPT, asset: offer.opened.borrowerNft(), value: 1n }, { script: lock }],
    )
    // output 1, explicit in the stand-in, becomes the confidential repayment
    const explicit =
      '01' + reversed(OTHER_ASSET) + '01' + u64be(1_000n) + '00' + pushLength(lock) + lock
    return replaceOnce(tx, explicit, repayment)
  }

  it('claim an installment that opens, up to the build', async () => {
    const { offer, loan } = await lenderLoan()
    const { deps } = lenderChain(offer)
    await expect(
      buildInstallmentClaim(deps, offer, loan, {
        installments: [installment],
        lenderNftOutpoint: lenderNftAtAcceptance,
        feeCoins,
      }),
    ).rejects.toThrow('the PSET build was reached')
  })

  it('refuse to claim what is not an unclaimed installment that opens', async () => {
    const { offer, loan } = await lenderLoan()
    const claim = await installmentClaimTx(offer)
    const { deps } = lenderChain(offer, claim)
    const claimWith = (installments: string[], lenderNftOutpoint = lenderNftAtAcceptance) =>
      buildInstallmentClaim(deps, offer, loan, { installments, lenderNftOutpoint, feeCoins })
    await expect(claimWith([])).rejects.toThrow('needs an installment')
    await expect(claimWith([`${acceptanceTxid}:1`])).rejects.toThrow(
      'is not an installment of this loan',
    )
    // claimed already, by the claim that holds the lender NFT now
    await expect(claimWith([installment], `${txidOf(claim)}:0`)).rejects.toThrow(
      `${installment} was claimed already, by ${txidOf(claim)}`,
    )
    // an installment whose range proof the lender cannot rewind
    const unopened = { ...loan, state: withSweep(loan.state, emptySweep) }
    await expect(
      buildInstallmentClaim(deps, offer, unopened, {
        installments: [installment],
        lenderNftOutpoint: lenderNftAtAcceptance,
        feeCoins,
      }),
    ).rejects.toThrow("does not open with this wallet's key")
    // the borrower
    const borrower = await openOffer('borrower')
    await expect(
      buildInstallmentClaim(deps, borrower, loan, {
        installments: [installment],
        lenderNftOutpoint: lenderNftAtAcceptance,
        feeCoins,
      }),
    ).rejects.toThrow('Only the lender claims installments')
  })

  it('sweep an unclaimed installment with the repayment, up to the build', async () => {
    const { offer, loan } = await lenderLoan()
    const close = fullRepaymentTx(offer, fakeChain().deps, loan)
    const claim = await installmentClaimTx(offer)
    const { deps } = lenderChain(offer, close, claim)
    const finalClaim = (unspentInstallments: string[], lenderNftOutpoint: string) =>
      buildFinalClaim(deps, offer, loan, {
        closeTxid: txidOf(close),
        unspentInstallments,
        lenderNftOutpoint,
        feeCoins,
      })
    // the installment unclaimed, and so swept with the repayment
    await expect(finalClaim([installment], lenderNftAtAcceptance)).rejects.toThrow(
      'the PSET build was reached',
    )
    // the installment claimed: the repayment alone
    await expect(finalClaim([], `${txidOf(claim)}:0`)).rejects.toThrow('the PSET build was reached')
  })

  // An indexer that omits an unspent installment would have it counted as claimed: the claim would
  // balance without it, burn the lender NFT and strand it. The lender NFT's claims show which
  // installments the lender took.
  it('refuse a final claim whose unspent installments disagree with the claims', async () => {
    const { offer, loan } = await lenderLoan()
    const close = fullRepaymentTx(offer, fakeChain().deps, loan)
    const claim = await installmentClaimTx(offer)
    const { deps, fetched } = lenderChain(offer, close, claim)
    const finalClaim = (unspentInstallments: string[], lenderNftOutpoint: string) =>
      buildFinalClaim(deps, offer, loan, {
        closeTxid: txidOf(close),
        unspentInstallments,
        lenderNftOutpoint,
        feeCoins,
      })
    await expect(finalClaim([], lenderNftAtAcceptance)).rejects.toThrow(
      `Installment ${installment} is neither listed as unspent nor claimed`,
    )
    await expect(finalClaim([installment], `${txidOf(claim)}:0`)).rejects.toThrow(
      `${installment} is listed as unspent, but the lender's claim ${txidOf(claim)} spent it`,
    )
    // a lender NFT outpoint that is not on the NFT's way from the acceptance
    await expect(finalClaim([installment], `${txidOf(close)}:0`)).rejects.toThrow(
      `${txidOf(close)}:0 does not hold the lender NFT`,
    )
    expect(fetched).not.toContain(txidOf(feeTx))
  })

  it('refuse a final claim of a close that does not spend the loan', async () => {
    const { offer, loan } = await lenderLoan()
    const other = standIn(
      [`${'f3'.repeat(32)}:0`, `${acceptanceTxid}:0`],
      [{ script: BURN_SCRIPT }],
    )
    const { deps } = lenderChain(offer, other)
    await expect(
      buildFinalClaim(deps, offer, loan, {
        closeTxid: txidOf(other),
        unspentInstallments: [installment],
        lenderNftOutpoint: lenderNftAtAcceptance,
        feeCoins,
      }),
    ).rejects.toThrow('loan-mismatch')
  })

  // Decision 1: after a zero-debt close whose installments were all claimed, the sweep is empty.
  it('refuse a final claim with nothing left to sweep, before building', async () => {
    const { offer, loan } = await lenderLoan()
    const close = standIn(
      [`${'f4'.repeat(32)}:0`, fixture.loan.loan_outpoint],
      [{ script: BURN_SCRIPT }],
    )
    const claim = await installmentClaimTx(offer)
    const { deps, fetched } = lenderChain(offer, close, claim)
    const refusal = await buildFinalClaim(
      deps,
      offer,
      { ...loan, state: withSweep(loan.state, emptySweep) },
      {
        closeTxid: txidOf(close),
        unspentInstallments: [],
        lenderNftOutpoint: `${txidOf(claim)}:0`,
        feeCoins,
      },
    ).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(NothingToClaimError)
    expect((refusal as NothingToClaimError).code).toBe('nothing-to-claim')
    // the close and the lender NFT's claim, but no output to spend
    expect(fetched).toEqual([txidOf(close), txidOf(claim)])
  })

  it('liquidate with the debt the loan holds after its installment, up to the build', async () => {
    const { offer, loan } = await lenderLoan()
    const expiry = offer.opened.loanExpirationTime()
    const liquidate = (deps: PrivateFlowDeps, unspentInstallments: string[], tipHeight: number) =>
      buildPrivateLiquidation(deps, offer, loan, {
        lenderNftOutpoint: lenderNftAtAcceptance,
        unspentInstallments,
        feeCoins,
        collateralReceiver: lenderChain(offer).deps.addresses.nextReceive(
          lenderChain(offer).deps.wollet,
        ),
        tipHeight,
      })
    // below the expiry: refused before anything is fetched
    const early = lenderChain(offer)
    await expect(liquidate(early.deps, [installment], expiry - 1)).rejects.toBeInstanceOf(
      ExpiryNotReachedError,
    )
    expect(early.fetched).toEqual([])
    // the unclaimed installment, which opens, is swept
    await expect(liquidate(lenderChain(offer).deps, [installment], expiry)).rejects.toThrow(
      'the PSET build was reached',
    )
    // an unspent installment left out would be stranded once the lender NFT burns
    await expect(liquidate(lenderChain(offer).deps, [], expiry)).rejects.toThrow(
      `Installment ${installment} is neither listed as unspent nor claimed`,
    )
  })
})
