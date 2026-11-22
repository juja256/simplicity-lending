// The creation of a private offer (spec, part A; `attach_creation` in the contracts' private
// lending core). The borrower issues both NFTs and the loan's carry token from its own coins,
// locks the lender NFT to the offer, and pays the collateral, blinded to the lender, into the
// pending offer:
//   inputs   0 first input (issues the borrower NFT), 1 lender NFT coin (issues the lender NFT),
//            2… collateral coins, the first of which issues the carry token: `CARRY_SUPPLY`
//            units, no reissuance token, fresh entropy;
//   outputs  0 borrower NFT to the borrower, 1 lender NFT at the lender-NFT lock, 2 OP_RETURN
//            marker, 3 pending offer, 4 the carry supply, explicit, at the principal's asset_auth
//            (borrower NFT, no burn); change and fee follow.
// The carries bound the remainder of proportional release by consensus (the design note's
// "Transactions"): every installment spends them, and the borrower NFT unlocks them. The supply
// is the same for every loan, so showing it reveals nothing.
import type { Address, Contract, WalletTxOut } from 'lwk_wasm'

import type { AsyncUpdatedPset } from '@/lwk/updatedPset'
import {
  CARRY_SUPPLY,
  CREATION_INPUT,
  CREATION_OUTPUT,
  LOCK_TIME_THRESHOLD,
  NFT_AMOUNT,
  NO_REISSUANCE_TOKEN,
} from '@/simplicity/private-lending/layout'
import {
  privateAssetAuthProgram,
  privateOfferScripts,
  toPrivateOfferArguments,
} from '@/simplicity/private-lending/scripts'
import { buildCovenantSpendInfo } from '@/simplicity/taproot'
import { hexToBytes } from '@/utils/hex'
import type { LendingKey } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from '../deps'
import { checkedMessage } from '../messages'
import { walletInputSecret } from '../secrets'
import { openAndVerifyOffer, PrivateOfferError, type VerifiedOffer } from '../verify'
import {
  assertSpendLayout,
  buildUnblindedPset,
  fetchPrevoutTxs,
  outpointOf,
  prevoutsOf,
  type SpendLayout,
  walletCoinInput,
  wasmStep,
} from './shared'

/**
 * The asset contracts of the NFTs and the carry token, never published. What matters is their
 * fresh issuer key: it gives every build new NFT ids, and so new offer secrets, and a carry token
 * of its own to every loan (fresh entropy).
 */
const NFT_CONTRACT_DOMAIN = 'simplicity-lending.private'
const NFT_CONTRACTS = {
  borrower: { name: 'simplicity-lending/private/v1 borrower-nft', ticker: 'SLPB' },
  lender: { name: 'simplicity-lending/private/v1 lender-nft', ticker: 'SLPL' },
  carry: { name: 'simplicity-lending/private/v1 carry', ticker: 'SLPC' },
} as const

export interface CreationParams {
  borrower: LendingKey
  /** The lender's lending key, x-only hex. */
  lender: string
  /** Input 0, which issues the borrower NFT; its outpoint is the offer's first input. */
  firstInput: WalletTxOut
  /** Input 1, which issues the lender NFT. */
  lenderNftCoin: WalletTxOut
  /**
   * Inputs 2…, which pay the collateral (and, with the other inputs, the fee). The first, input 2,
   * issues the carry token.
   */
  collateralCoins: WalletTxOut[]
  collateralAmount: bigint
  principalAmount: bigint
  repaymentAmount: bigint
  /** The block height from which the lender may liquidate. */
  loanExpirationTime: number
  /** Receives the borrower NFT, as an explicit output. */
  borrowerNftReceiver: Address
  /**
   * The borrower's private message to the lender, in the signed terms: at most
   * `MESSAGE_LIMITS.creation` UTF-8 bytes. An empty or blank one is none.
   */
  message?: string
}

export interface CreationSummary {
  creationTxHex: string
  /** The pending offer, `"<txid>:3"`. */
  offerOutpoint: string
  borrowerNft: string
  lenderNft: string
  /** The loan's carry token, issued at input 2: its supply is at `"<txid>:4"`. */
  carryAsset: string
  /** Repayment − principal, in principal units. */
  interest: bigint
}

/**
 * Why the borrower's app refuses an offer of `collateral` and full repayment `repayment` (base
 * units), or undefined within the bounds of proportional release, `1 ≤ C ≤ 2^44` and
 * `1 ≤ R ≤ 2^50 − 2` (`wasm.checkOfferBounds`): the lender refuses an offer outside them, since
 * the release proof is sound only within them (proofs, O9).
 */
export function offerBoundsError(
  wasm: Pick<PrivateFlowDeps['wasm'], 'checkOfferBounds'>,
  collateral: bigint,
  repayment: bigint,
): string | undefined {
  try {
    wasm.checkOfferBounds(collateral, repayment)
    return undefined
  } catch (error) {
    const text = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
    return text.replace(/^out-of-bounds: /, '') || 'The offer is outside the bounds of release'
  }
}

/** The terms' interest rate, for display only: the interest is repayment − principal. */
function interestRateBps(principal: bigint, repayment: bigint): number {
  if (principal <= 0n) throw new Error('The principal must be positive')
  if (repayment < principal) throw new Error('The repayment must not be below the principal')
  const bps = ((repayment - principal) * 10_000n) / principal
  if (bps > 0xffffn) throw new Error('The interest must not exceed 655.35 % of the principal')
  return Number(bps)
}

function freshContract(deps: PrivateFlowDeps, nft: keyof typeof NFT_CONTRACTS): Contract {
  const { name, ticker } = NFT_CONTRACTS[nft]
  return new deps.lwk.Contract(
    NFT_CONTRACT_DOMAIN,
    deps.wasm.freshIssuerPubkey(),
    name,
    0,
    ticker,
    0,
  )
}

/**
 * Builds the creation of a private offer from the borrower's wallet coins, blinded and ready to
 * sign. `finalize` finalizes the wallet inputs and runs the borrower's self-check
 * (`openAndVerifyOffer('borrower', …)`) on the finished transaction: any failure is fatal, since
 * a broadcast offer that does not open would strand the collateral.
 *
 * Every call draws fresh NFTs, so it is a new offer. A retry must rebroadcast the finalized hex,
 * never call this again.
 */
export async function buildPrivateCreation(
  deps: PrivateFlowDeps,
  params: CreationParams,
): Promise<AsyncUpdatedPset<CreationSummary>> {
  const { lwk, wasm } = deps
  const message = checkedMessage(params.message, 'creation')
  const outOfBounds = offerBoundsError(wasm, params.collateralAmount, params.repaymentAmount)
  if (outOfBounds !== undefined)
    throw new Error(`The lender would refuse this offer: ${outOfBounds}`)
  const coins = [params.firstInput, params.lenderNftCoin, ...params.collateralCoins]
  const outpoints = coins.map(outpointOf)
  const [firstInput, lenderNftInput] = outpoints
  if (params.collateralCoins.length === 0) throw new Error('A creation needs a collateral coin')
  if (new Set(outpoints).size !== outpoints.length) {
    throw new Error('The first input, the lender NFT coin and the collateral coins must differ')
  }
  let collateralIn = 0n
  for (const coin of params.collateralCoins) {
    const secrets = coin.unblinded()
    if (secrets.asset().toString() !== deps.assets.collateral) {
      throw new Error(`Collateral coin ${outpointOf(coin)} is not the collateral asset`)
    }
    collateralIn += secrets.value()
  }
  if (collateralIn < params.collateralAmount) {
    throw new Error('The collateral coins hold less than the collateral amount')
  }
  const expiration = params.loanExpirationTime
  if (!Number.isInteger(expiration) || expiration < 0 || expiration >= LOCK_TIME_THRESHOLD) {
    throw new Error('The loan expiration must be a block height')
  }
  const lender = params.lender.trim().toLowerCase()
  const interest = params.repaymentAmount - params.principalAmount
  const borrowerNftReceiver = lwk.Address.parse(
    params.borrowerNftReceiver.toString(),
    deps.network,
  ).toUnconfidential()
  // The transactions of the coins: the PSET carries every input's prevout.
  const prevoutTxs = await fetchPrevoutTxs(deps, outpoints)

  // 1. Fresh NFT and carry contracts, and the ids they give before the transaction exists. The
  // PSET issues with the same contract hashes, so its issuances give exactly these ids.
  const contractHashOf = (asset: keyof typeof NFT_CONTRACTS) =>
    wasm.contractHashFromJson(freshContract(deps, asset).toString())
  const borrowerNftContractHash = contractHashOf('borrower')
  const lenderNftContractHash = contractHashOf('lender')
  const carryContractHash = contractHashOf('carry')
  const borrowerNft = wasm.issuedAssetId(firstInput, borrowerNftContractHash)
  const lenderNft = wasm.issuedAssetId(lenderNftInput, lenderNftContractHash)
  const carryAsset = wasm.issuedAssetId(outpoints[CREATION_INPUT.carryIssuance], carryContractHash)

  // 2. The offer: terms signed for the lender, pinned blinders, the marker.
  const terms = new wasm.OfferTermsInput(
    deps.assets.principal,
    params.principalAmount,
    params.repaymentAmount,
    interestRateBps(params.principalAmount, params.repaymentAmount),
    params.loanExpirationTime,
    borrowerNft,
    lenderNft,
  )
  const newOffer = wasmStep('Building the offer', () =>
    wasm.NewOffer.build(
      params.borrower,
      lender,
      firstInput,
      deps.assets.collateral,
      params.collateralAmount,
      terms,
      message,
    ),
  )
  // The offer holds the creation's ephemeral key. `finalize` needs nothing of it, so it is freed
  // once the PSET is blinded, or the build fails.
  let layout: SpendLayout
  let blindedBase64: string
  try {
    const collateralBlindingKey = newOffer.collateralBlindingKey()
    const pinned = newOffer.pinned(wasm.PinnedRole.PendingCollateral)
    const pendingCollateral = {
      assetCommitment: pinned.assetCommitment,
      valueCommitment: pinned.valueCommitment,
    }

    // 3. The contract's scripts.
    const args = toPrivateOfferArguments(
      wasmStep("The offer's arguments", () => newOffer.contractArguments()),
    )
    const scripts = privateOfferScripts(deps.sources, args, deps.network)
    const pendingOffer = new lwk.Address(
      wasmStep('The pending offer address', () =>
        wasm.confidentialAddress(
          scripts.pendingOffer.toString(),
          collateralBlindingKey,
          deps.networkName,
        ),
      ),
    )
    const marker = lwk.Script.newOpReturn(hexToBytes(newOffer.marker()))
    // The carry supply's lock, the principal's asset_auth: the hash the contract pins.
    const carryLock = buildCovenantSpendInfo(
      privateAssetAuthProgram(deps.sources, args.borrowerNftAssetId, false),
    ).scriptPubkey
    if (carryLock.jet_sha256_hex() !== scripts.principalOutputScriptHash) {
      throw new Error("The carry supply's lock is not the one the offer's contract pins")
    }

    // inputs 0 and 1 issue the NFTs, input 2 the carry token; outputs in `CREATION_OUTPUT` order
    layout = {
      inputs: outpoints,
      issuances: [
        { asset: borrowerNft, amount: NFT_AMOUNT },
        { asset: lenderNft, amount: NFT_AMOUNT },
        { asset: carryAsset, amount: CARRY_SUPPLY },
      ],
      outputs: [
        {
          script: borrowerNftReceiver.scriptPubkey().toString(),
          asset: borrowerNft,
          amount: NFT_AMOUNT,
          blinding: { kind: 'explicit' },
        },
        {
          script: scripts.lenderNftLock.toString(),
          asset: lenderNft,
          amount: NFT_AMOUNT,
          blinding: { kind: 'explicit' },
        },
        {
          script: marker.toString(),
          asset: deps.assets.policy,
          amount: 0n,
          blinding: { kind: 'explicit' },
        },
        {
          script: scripts.pendingOffer.toString(),
          asset: deps.assets.collateral,
          amount: params.collateralAmount,
          blinding: {
            kind: 'pinned',
            blindingKey: collateralBlindingKey,
            pinned: pendingCollateral,
          },
        },
        {
          script: carryLock.toString(),
          asset: carryAsset,
          amount: CARRY_SUPPLY,
          blinding: { kind: 'explicit' },
        },
      ],
      restrictedAssets: [borrowerNft, lenderNft, carryAsset],
      restrictedScripts: [
        scripts.lenderNftLock.toString(),
        scripts.pendingOffer.toString(),
        carryLock.toString(),
      ],
      policyAsset: deps.assets.policy,
    }

    // 4. The unblinded PSET: the wallet coins in `layout.inputs` order, inputs 0 and 1 each
    // issuing one unit of its NFT and input 2 the carry supply, without a reissuance token; the
    // outputs in layout order.
    const issuances = [
      { amount: NFT_AMOUNT, contractHash: borrowerNftContractHash },
      { amount: NFT_AMOUNT, contractHash: lenderNftContractHash },
      { amount: CARRY_SUPPLY, contractHash: carryContractHash },
    ]
    const prevouts = prevoutsOf(prevoutTxs, outpoints)
    const unblinded = buildUnblindedPset(deps, {
      inputs: coins.map((coin, index) => {
        const issuance = issuances[index]
        return {
          ...walletCoinInput(deps, coin, prevouts[index]),
          issuance:
            issuance === undefined
              ? undefined
              : {
                  assetAmount: issuance.amount,
                  tokenAmount: NO_REISSUANCE_TOKEN,
                  contractHash: lwk.ContractHash.fromString(issuance.contractHash),
                },
        }
      }),
      outputs: [
        {
          script: borrowerNftReceiver.scriptPubkey(),
          amount: NFT_AMOUNT,
          asset: lwk.AssetId.fromString(borrowerNft),
        },
        {
          script: scripts.lenderNftLock,
          amount: NFT_AMOUNT,
          asset: lwk.AssetId.fromString(lenderNft),
        },
        { script: marker, amount: 0n, asset: lwk.AssetId.fromString(deps.assets.policy) },
        {
          script: pendingOffer.scriptPubkey(),
          amount: params.collateralAmount,
          asset: lwk.AssetId.fromString(deps.assets.collateral),
          blindingPubkey: pendingOffer.blindingPubkey(),
        },
        {
          script: carryLock,
          amount: CARRY_SUPPLY,
          asset: lwk.AssetId.fromString(carryAsset),
        },
      ],
      changeAddress: deps.addresses.nextChange(deps.wollet, 1)[0],
    })

    // 5. The layout of the unblinded PSET.
    assertSpendLayout(deps, unblinded, layout, false, 'Creation')

    // 6. Blinding: the pending collateral with its pinned blinders, the rest freshly.
    blindedBase64 = wasmStep('Blinding the creation', () =>
      wasm.blindPset(
        unblinded.toString(),
        coins.map((coin, index) => walletInputSecret(deps, coin, index)),
        [newOffer.collateralBlinding(CREATION_OUTPUT.pendingOffer)],
      ),
    )
  } finally {
    newOffer.free()
  }
  const blinded = new lwk.Pset(blindedBase64)

  // 7. The layout again, now blinded.
  assertSpendLayout(deps, blinded, layout, true, 'Creation')
  const builtTxid = new lwk.Pset(blindedBase64).extractTx().txid().toString()

  // 8. Sign (by the caller), then finalize and self-check.
  return {
    pset: blinded,
    finalize: async signedPset => {
      const finalizedTx = deps.wollet.finalize(signedPset).extractTx()
      const txid = finalizedTx.txid().toString()
      if (txid !== builtTxid) {
        throw new Error('The signed creation is not the transaction that was built')
      }
      const creationTxHex = finalizedTx.toString()

      let offer: VerifiedOffer
      try {
        offer = await openAndVerifyOffer(deps, 'borrower', params.borrower, creationTxHex)
      } catch (error) {
        // Every code is fatal here, even "not addressed to this key".
        if (error instanceof PrivateOfferError) {
          throw new PrivateOfferError(
            error.code,
            `The creation failed the borrower's self-check and must not be broadcast: ${error.message}`,
            true,
          )
        }
        throw error
      }
      const opened = offer.opened
      let mismatch: (string | false)[]
      try {
        mismatch = [
          opened.firstInput() !== firstInput && 'first input',
          opened.borrowerNft() !== borrowerNft && 'borrower NFT',
          opened.lenderNft() !== lenderNft && 'lender NFT',
          opened.lenderPublicKey() !== lender && 'lender',
          opened.collateralAsset() !== deps.assets.collateral && 'collateral asset',
          opened.collateralAmount() !== params.collateralAmount && 'collateral',
          opened.principalAsset() !== deps.assets.principal && 'principal asset',
          opened.principalAmount() !== params.principalAmount && 'principal',
          opened.repaymentAmount() !== params.repaymentAmount && 'repayment',
          opened.loanExpirationTime() !== params.loanExpirationTime && 'loan expiration',
          opened.message() !== message && 'message',
        ].filter(Boolean)
      } finally {
        // The opened offer holds the offer's secrets, and nothing reads it after this check.
        opened.free()
      }
      if (mismatch.length > 0) {
        throw new PrivateOfferError(
          'terms-mismatch',
          `The created offer does not carry the requested ${mismatch.join(', ')}`,
          true,
        )
      }

      return {
        finalizedTx,
        summary: {
          creationTxHex,
          offerOutpoint: `${txid}:${CREATION_OUTPUT.pendingOffer}`,
          borrowerNft,
          lenderNft,
          carryAsset,
          interest,
        },
      }
    },
  }
}
