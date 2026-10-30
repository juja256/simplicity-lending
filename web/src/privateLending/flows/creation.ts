// The creation of a private offer (spec, part A). The borrower issues both NFTs from its own
// coins, locks the lender NFT to the offer, and pays the collateral, blinded to the lender, into
// the pending offer:
//   inputs   0 first input (issues the borrower NFT), 1 lender NFT coin (issues the lender NFT),
//            2… collateral coins;
//   outputs  0 borrower NFT to the borrower, 1 lender NFT at the lender-NFT lock, 2 OP_RETURN
//            marker, 3 pending offer; change and fee follow.
import type { Address, Contract, WalletTxOut } from '@lilbonekit/lwk-web'

import type { AsyncUpdatedPset } from '@/lwk/updatedPset'
import {
  CREATION_OUTPUT,
  NFT_AMOUNT,
  NO_REISSUANCE_TOKEN,
} from '@/simplicity/private-lending/layout'
import { privateOfferScripts, toPrivateOfferArguments } from '@/simplicity/private-lending/scripts'
import { hexToBytes } from '@/utils/hex'
import type { LendingKey } from '@/wasm/private-lending/private_lending_wasm'

import type { PrivateFlowDeps } from '../deps'
import { walletInputSecret } from '../secrets'
import { openAndVerifyOffer, PrivateOfferError, type VerifiedOffer } from '../verify'
import { assertSpendLayout, outpointOf, type SpendLayout, wasmStep } from './shared'

/** Lock times from here on are timestamps, which a block height never reaches. */
const LOCK_TIME_THRESHOLD = 500_000_000

/**
 * The NFTs' asset contracts, never published. What matters is their fresh issuer key: it gives
 * every build new NFT ids, and so new offer secrets.
 */
const NFT_CONTRACT_DOMAIN = 'simplicity-lending.private'
const NFT_CONTRACTS = {
  borrower: { name: 'simplicity-lending/private/v1 borrower-nft', ticker: 'SLPB' },
  lender: { name: 'simplicity-lending/private/v1 lender-nft', ticker: 'SLPL' },
} as const

export interface CreationParams {
  borrower: LendingKey
  /** The lender's lending key, x-only hex. */
  lender: string
  /** Input 0, which issues the borrower NFT; its outpoint is the offer's first input. */
  firstInput: WalletTxOut
  /** Input 1, which issues the lender NFT. */
  lenderNftCoin: WalletTxOut
  /** Inputs 2…, which pay the collateral (and, with the other inputs, the fee). */
  collateralCoins: WalletTxOut[]
  collateralAmount: bigint
  principalAmount: bigint
  repaymentAmount: bigint
  /** The block height from which the lender may liquidate. */
  loanExpirationTime: number
  /** Receives the borrower NFT, as an explicit output. */
  borrowerNftReceiver: Address
}

export interface CreationSummary {
  creationTxHex: string
  /** The pending offer, `"<txid>:3"`. */
  offerOutpoint: string
  borrowerNft: string
  lenderNft: string
  /** Repayment − principal, in principal units. */
  interest: bigint
}

/** The terms' interest rate, for display only: the interest is repayment − principal. */
function interestRateBps(principal: bigint, repayment: bigint): number {
  if (principal <= 0n) throw new Error('The principal must be positive')
  if (repayment < principal) throw new Error('The repayment must not be below the principal')
  const bps = ((repayment - principal) * 10_000n) / principal
  if (bps > 0xffffn) throw new Error('The interest must not exceed 655.35 % of the principal')
  return Number(bps)
}

function freshNftContract(deps: PrivateFlowDeps, nft: keyof typeof NFT_CONTRACTS): Contract {
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

  // 1. Fresh NFT contracts, and the ids they give before the transaction exists.
  const borrowerNftContract = freshNftContract(deps, 'borrower')
  const lenderNftContract = freshNftContract(deps, 'lender')
  const borrowerNft = wasm.issuedAssetId(
    firstInput,
    wasm.contractHashFromJson(borrowerNftContract.toString()),
  )
  const lenderNft = wasm.issuedAssetId(
    lenderNftInput,
    wasm.contractHashFromJson(lenderNftContract.toString()),
  )

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
    ),
  )
  const collateralBlindingKey = newOffer.collateralBlindingKey()
  const pinned = newOffer.pinned(wasm.PinnedRole.PendingCollateral)
  const pendingCollateral = {
    assetCommitment: pinned.assetCommitment,
    valueCommitment: pinned.valueCommitment,
  }

  // 3. The contract's scripts.
  const scripts = privateOfferScripts(
    deps.sources,
    toPrivateOfferArguments(newOffer.contractArguments()),
    deps.network,
  )
  const lenderNftLock = lwk.TxOut.fromExplicit(
    scripts.lenderNftLock,
    lwk.AssetId.fromString(lenderNft),
    NFT_AMOUNT,
  ).unconfidentialAddress(deps.network)
  if (!lenderNftLock) throw new Error('The lender NFT lock has no address')
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

  // inputs 0 and 1 issue the NFTs; outputs in `CREATION_OUTPUT` order
  const layout: SpendLayout = {
    inputs: outpoints,
    issuances: [borrowerNft, lenderNft],
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
        blinding: { kind: 'pinned', blindingKey: collateralBlindingKey, pinned: pendingCollateral },
      },
    ],
    restrictedAssets: [borrowerNft, lenderNft],
    restrictedScripts: [scripts.lenderNftLock.toString(), scripts.pendingOffer.toString()],
    policyAsset: deps.assets.policy,
  }

  // 4. The unblinded PSET.
  let builder = new lwk.TxBuilder(deps.network)
  if (deps.feeRate !== null) builder = builder.feeRate(deps.feeRate)
  builder = builder
    .setWalletUtxos(outpoints.map(outpoint => new lwk.OutPoint(outpoint)))
    .setInputOrder(outpoints.map(outpoint => new lwk.OutPoint(outpoint)))
    .issueAssetToRecipients(
      [lwk.IssuanceRecipient.fromAddress(NFT_AMOUNT, borrowerNftReceiver)],
      NO_REISSUANCE_TOKEN,
      null,
      borrowerNftContract,
      new lwk.OutPoint(firstInput),
    )
    .issueAssetToRecipients(
      [lwk.IssuanceRecipient.fromAddress(NFT_AMOUNT, lenderNftLock)],
      NO_REISSUANCE_TOKEN,
      null,
      lenderNftContract,
      new lwk.OutPoint(lenderNftInput),
    )
    .addPostIssuanceScriptOutput(marker, 0n, lwk.AssetId.fromString(deps.assets.policy))
    .addPostIssuanceRecipient(
      pendingOffer,
      params.collateralAmount,
      lwk.AssetId.fromString(deps.assets.collateral),
    )
    // last, so that no later builder call can reset it
    .skipBlinding()
  const unblinded = builder.finish(deps.wollet)

  // 5. The layout LWK built.
  assertSpendLayout(deps, unblinded, layout, false, 'Creation')

  // 6. Blinding: the pending collateral with its pinned blinders, the rest freshly.
  const blindedBase64 = wasmStep('Blinding the creation', () =>
    wasm.blindPset(
      unblinded.toString(),
      coins.map((coin, index) => walletInputSecret(deps, coin, index)),
      [newOffer.collateralBlinding(CREATION_OUTPUT.pendingOffer)],
    ),
  )
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
      const mismatch = [
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
      ].filter(Boolean)
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
          interest,
        },
      }
    },
  }
}
