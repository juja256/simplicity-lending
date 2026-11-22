# private-lending-wasm

The browser side of Simplicity Lending private offers: [`private-lending-core`](../private-lending-core)
compiled to WebAssembly with `wasm-bindgen`. The web app calls it for every private-offer
cryptographic operation, so the browser runs the same code as the contracts' tests.

## Building

From `web/`, `pnpm build:wasm` runs `wasm-pack build` and writes the package to
`web/src/wasm/private-lending/` (git-ignored). Prerequisites:

- `rustup target add wasm32-unknown-unknown`;
- `wasm-pack` (`cargo install wasm-pack --locked`);
- a clang that can target wasm32, and `llvm-ar`, to compile the secp256k1-zkp C sources. On
  macOS, Apple clang cannot target wasm32: install Homebrew `llvm` and put it first on `PATH`.

## API conventions

- JS names are camelCase through `js_name`; Rust names are snake_case.
- Txids and asset ids are display-order hex; outpoints are `"<txid>:<vout>"`.
- Keys, nonces, markers and other byte strings are plain lowercase hex; hex inputs are accepted in
  either case, after trimming whitespace.
- Amounts are `u64`, which is `bigint` in JS. PSETs are base64; transactions are consensus-encoded
  hex.

### Byte orders

`ContractArguments` NFT ids (`borrowerNftAssetId`, `lenderNftAssetId`) are in **internal** byte
order: the hex to hand to `SimplicityTypedValue.fromU256Hex`. They differ from `borrowerNft()` and
`lenderNft()` on the same object, which are display order, like every other asset id.

### Errors

Errors are thrown as JS **strings**, not `Error` objects, of the form `<code>: <message>`; the
code is the text before `": "`. No exported function builds a `JsValue` or `JsError`, since those
panic outside wasm, so native tests call the same functions.

- Not addressed to this key (skip silently): `not-found`, `view-tag-mismatch`, `not-mine`,
  `rewind-failed`.
- Addressed to this key but invalid (show as invalid): `terms-invalid`, `collateral-mismatch`,
  `invalid-terms`, `lender-nft-not-unique`, `nft-output-mismatch`.
- Outside the bounds of proportional release, `1 ≤ C ≤ 2^44` and `1 ≤ R ≤ 2^50 − 2`:
  `out-of-bounds`, from `checkOfferBounds`, `NewOffer.build`, `openCreationAsLender` and
  `loanState`. The lender must not accept such an offer: the release proof is sound only within
  the bounds.
- A transaction given as a loan's acceptance, installment or close that is not the loan's:
  `loan-mismatch`, naming the acceptance or the installment (from 1).
- Bad caller input: `bad-input`.
- A release proof that does not verify: `proof-invalid`, from `planInstallment`, a bug. The
  installment must not be broadcast.

The borrower's pre-broadcast self-check of an offer it just built must treat every code as fatal.

### Validity

A successful `openCreationAsLender` / `openCreationAsBorrower` does not make an offer valid: the
terms and the collateral are checked, but not the bounds nor the addresses. Before accepting, the
lender also runs `OpenedOffer.checkOfferBounds()` and the address check, `verifyOfferAddresses` in
`web/src/simplicity/private-lending/scripts.ts`, with `contractArguments()`, which recomputes
every argument, the release proof's points, `FS_IV` and `BLINDER_ROOT` included, from the shared
secret and the terms (proofs, O9). `openCreationAsLender` already refuses an offer outside the
bounds; `openCreationAsBorrower` opens it, so that its borrower can cancel it.

### Blinding

- `blindPset` consumes its `InputSecret` and `PinnedBlinding` handles, even on error. Create fresh
  ones for every call.
- Issuance inputs must not be blinded (`blinded_issuance = 0`), or blinding fails.
- **The collateral blinding key rule.** The core requires the creation's collateral output (output
  3) to carry the blinding key `NewOffer.collateralBlindingKey()`, the lender's lifted key, and
  acceptance outputs to carry `OpenedOffer.borrowerBlindingKey()`. The PSET output must carry
  exactly that key, or the offer cannot be opened and the collateral is stranded.

## Exports

Keys:

- `LendingKey.fromDescriptor`, `LendingKey.fromMasterBlindingKey`: a lending key from a wallet's
  descriptor or SLIP-77 master blinding key.
- `LendingKey.xOnlyPublicKey()`, `LendingKey.fingerprint()`: the public identity and its short
  fingerprint.
- `keyFingerprint(xOnlyHex)`: the fingerprint of an x-only key.
- `liftLendingKey(xOnlyHex)`: the 33-byte compressed key (hex) that outputs addressed to a lending
  key are blinded to.

Scanning:

- `viewTagMatches(key, nonceHex, viewTag)`: the cheap filter for offers addressed to a lender.
- `isOwnCandidate(borrower, firstInput, borrowerNft, lenderNft, nonceHex)`: whether an offer's nonce
  is this borrower's.
- `privateLendingProgramId()`: the marker's program id.

Opening:

- `openCreationAsLender(key, creationTxHex)`, `openCreationAsBorrower(key, creationTxHex)`: open an
  offer into an `OpenedOffer`. Only terms of version 2, which carry the borrower's message, open;
  any other version is `terms-invalid`. The lender's also refuses an offer outside the bounds of
  release (`out-of-bounds`).
- `OpenedOffer` getters: `principalAsset`, `principalAmount`, `repaymentAmount`, `interestRateBps`,
  `loanExpirationTime`, `borrowerNft`, `lenderNft`, `borrowerPublicKey`, `lenderPublicKey`,
  `collateralAsset`, `collateralAmount`, `firstInput`.
- `OpenedOffer.borrowerBlindingKey()`, `OpenedOffer.lenderBlindingKey()`: the lifted keys.
- `OpenedOffer.contractArguments()`: the `ContractArguments` of the offer's contract. Besides the
  phase 5 arguments it has the release proof's `repaymentAssetPoint`, `collateralAssetPoint`,
  `collateralValuePoint` and `startingDebtPoint` (curve points as `x ‖ y`, 64 bytes, hex), `fsIv`
  and `blinderRoot`. The first call builds the offer's tree of blinder commitments (2,048 scalar
  multiplications); the offer keeps it, and its loan states and plans share it.
- `OpenedOffer.checkOfferBounds()`, `checkOfferBounds(collateral, repayment)`: the bounds of
  proportional release, `out-of-bounds` outside them. `carrySupply()`: the carry token's supply,
  `S = 2^50`, which the creation issues at input 2 and holds, explicit, at output 4.
- `OpenedOffer.pinned(role)`: the `PinnedOutputInfo` (asset, amount, blinders, commitments) of a
  `PinnedRole`.

Building and blinding:

- `OfferTermsInput`, `NewOffer.build(..., terms, message?)`: validate terms and build an offer,
  with the borrower's message to the lender in the signed terms (`out-of-bounds` outside the bounds
  of release); `marker()`, `contractArguments()`, `pinned(role)`, `lenderPublicKey()`.
- `NewOffer.collateralBlinding(outputIndex)`, `NewOffer.collateralBlindingKey()`: how and to which
  key to blind the creation's collateral output.
- `issuedAssetId(outpoint, contractHash)`: the id of an asset before its issuing transaction exists.
- `OpenedOffer.pinnedBlinding(role, outputIndex, message?)`: how to blind a pinned output of
  acceptance or repayment (`bad-input` for the pending collateral, which only creation blinds).
  Only the principal takes a message, signed by the lender for `Acceptance` of this offer.
- `OpenedOffer.inputSecret(role, inputIndex)`, `InputSecret` (`new`, `explicit`): the secrets of
  covenant and wallet inputs.
- `blindPset(psetBase64, inputSecrets, blindings)`: blind a PSET.
- `inspectPset(psetBase64)`: JSON of the PSET fields LWK's JS API does not expose, which the flows
  check before signing: the lock time the extracted transaction gets (`lockTime`), each input's
  prevout, sequence and issuance (asset and token ids, amounts or commitments, inflation keys,
  `blinded_issuance`), and each output's script, explicit asset and amount, commitments, nonce
  (`ecdhPubkey`), blinding key, blinder index and blind proofs. Absent fields are `null` (an input
  with no sequence is extracted with `0xffffffff`); amounts are decimal strings. `bad-input` for
  inputs whose required lock times conflict.

Loans:

- `OpenedOffer.loanState(key, acceptanceTxHex, installmentTxHexes)`: the `LoanState` after the
  acceptance and the installments, read with the lending key of the party that opened the offer.
  `out-of-bounds` for an offer outside the bounds of release. The acceptance must spend the
  creation's pending offer (output 3) at input 0 and hold the active collateral at output 0. Each
  installment must spend the previous loan output at input 1, pay `A` at output 2, and hold at
  output 1 the collateral of its step `j`: the asset commitment `A_c + j·G` always, and exactly
  `c_j = ceil(d_j·C/R)` with the step's blinders when the party knows the debt `d_j`. A loan has at
  most 1024 installments. The scripts are the caller's to check, against
  `activeOfferAt(state.debtHashAt(j))` in `web/src/simplicity/private-lending/scripts.ts`.
- `LoanState` getters: `installmentCount`, `loanOutpoint`, `debtCommitment`, `debtHash`, `paid`
  (what opened for the party) and `remaining` (`undefined` unless every installment opened);
  `debtHashAt(j)` (0 the acceptance's loan output), `installment(j)` (from 1).
- `installment(j)` is an `InstallmentInfo`: `outpoint`, `amount` and `message`, the borrower's
  message read in the same rewind (`undefined` when it does not open or carries none,
  `bad-input` when its field does not decode).
- The collateral, `c_k` at step `k`: `collateral()`, a `PinnedOutputInfo` (`undefined` while
  `c_k` is unknown), and `loanInputSecret(inputIndex)` (`bad-input` while it is). It is known when
  the debt is, and `C` at acceptance. The collateral released is the offer's
  `collateralAmount()` less `c_k`.
- The lender's search, when an installment does not open: `collateralSearch()`, a
  `CollateralSearch` of plain values (`valueCommitment`, `assetCommitment`, `blinder`, the step's
  secret `x_k`, and `max`, the collateral `C`); `findCollateral(valueCommitment, assetCommitment,
  blinder, max)`, a free function for a Web Worker, which gives `c_k` or `undefined` (about 1 s
  and 32 MiB at `max = 2^44`, `bad-input` above it); then `setCollateral(c_k)`, which refuses an
  amount that does not open the loan output. `collateralOpening(step, amount, assetBlinder,
  blinder)` gives the blinders of the collateral of `amount` at `step`, from 1 to 1024.
- `releasePreview(amount)`: the collateral that paying `amount` releases now, from 1 to the
  amount owed (which releases all of `c_k`), while the debt is known.
- Borrower only, else `bad-input`:
  - `carries()`: the loan's `Carry`s (`outpoint`, `asset`, `amount`, `inputSecret(i)`), opened
    from the chain: the creation's carry supply before the first installment, then the last
    installment's outputs 3 and 4, rewound with the borrower's lending key. `loan-mismatch`
    unless they are of the creation's carry token and hold `e + 1` and `R − e` units. An
    installment and the full repayment spend them after the principal coins.
  - `carrySweep()`: the full repayment's burn of every carry unit, a `CarrySweep` with `burn`
    (its `PinnedOutputInfo`, commitments included, blinders drawn once) and `blinding(i)` for its
    `OP_RETURN`, whose PSET output carries `borrowerBlindingKey()`.
  - `planInstallment(amount, firstWalletInput, nftReceiverScript, message?)`: an
    `InstallmentPlan`, for an amount above 0 and below the remaining debt, before step 1024, the
    message signed for `Installment` of `installmentCount + 1`. The plan proves the release and
    verifies the proof with the loan's `FS_IV`, and `Y` against `BLINDER_ROOT`, before it returns
    (proofs, O7). It has:
    - the witness: `debtWitness`, `index`, `blinderCommitment`, `pathIsRight`, `pathSiblings`,
      `commitments` (`T1 … T7`) and `responses` (eleven), as
      `web/src/simplicity/private-lending/witness.ts` takes them;
    - `successorDebtHash`, `ephemeralPublicKey` (the installment's nonce), `installment`,
      `successor`, `installmentBlinding(i)` and `successorBlinding(i)`;
    - `carry(k)` and `carryBlinding(k, i)`, `k` 0 for `W1` (output 3, `e + 1` units) and 1 for
      `W2` (output 4, `R − e`), whose PSET outputs carry `borrowerBlindingKey()`;
    - `release`, the collateral released to the borrower, which can be 0;
    - `leftover`, the carry units the first installment burns (`S − R − 1`, 0 later),
      `leftoverBurn` (its `PinnedOutputInfo`) and `leftoverBlinding(i)` for its `OP_RETURN`, both
      `undefined` when there is none.

    Each plan draws random blinders. Two plans at one step share `x_(k+1)`: save a build and
    rebroadcast it rather than plan again (design note, "Never rebuild an index with another
    amount").
  - `repaymentBlinding(i, message?)` while an amount is owed, the message signed for
    `FullRepayment`.
- Lender only, else `bad-input`: `sweep(closeTxHex, unspent)`, the `Sweep` (`outpoints()`,
  `amount`, `inputSecret(position, inputIndex)`) of the final claim after the full repayment, or
  of a liquidation when `closeTxHex` is `undefined`.

Messages (the format and the limits are in the core's `message.rs`):

- `signMessage(sender, creationTxid, phase, installment, text)`: a `SignedMessage` by the
  sender's lending key for a `MessagePhase` (`Acceptance`, `Installment` with `installment` from
  1, or `FullRepayment`) of the offer. `bad-input` for an empty text and for one over 3068 bytes
  in UTF-8, naming both numbers; `NewOffer.build` allows 2915 at creation. The builders that take
  a `SignedMessage` consume the handle and refuse one signed for another phase, another offer or
  by the other party.
- `OpenedOffer.message()`: the creation's text, covered by the terms' signature, `undefined` for
  none. Terms whose message field does not decode do not open (`terms-invalid`).
- `OpenedOffer.readMessage(key, creationTxid, txHex, outputIndex, phase)`: a `ReadMessage`
  (`text`, `verified`) from an output that `key` rewinds with its nonce, checked against the
  lender's key for `Acceptance` and the borrower's for `FullRepayment`; `undefined` when the
  output does not rewind or carries none, `bad-input` when the field does not decode and for
  `Installment`, which `LoanState.installment(j).message` reads.
- A message that does not verify keeps its text: show it as unverified, since the other party
  knows the output's blinders and can move a message between outputs.
- `ReadMessage.text`, `OpenedOffer.message()` and `InstallmentInfo.message` give the text as it was
  sent, control characters included: the caller removes them before showing it (`displayMessage`
  in `web/src/privateLending/messages.ts`).
- The testnet e2e (`web/README.md`) reads each message back the way the app does: the creation's
  through `message()`, the acceptance's as the borrower and the full repayment's as the lender
  through `readMessage`, and each installment's as both parties through `loanState`.

LWK helpers:

- `confidentialAddress(scriptPubkeyHex, blindingKeyHex, network)`: the confidential address of a
  script with a chosen 33-byte blinding key; `network` is `liquid`, `liquidtestnet` or `regtest`.
  LWK cannot build one. `bad-input` for a script with no address form.
- `contractHashFromJson(json)`: the ELIP-100 contract hash of LWK's `Contract.toString()`, in the
  format `issuedAssetId` takes.
- `freshIssuerPubkey()`: a random compressed public key (hex) for a contract's `issuer_pubkey`, so
  each issuance has fresh entropy. The secret is discarded.

Directory:

- `signDirectoryAction(key, action, challengeHex, displayName, termsJson)`: the Schnorr signature
  (hex) over a server challenge, with `DirectoryAction.Put` or `Delete`. A put signs a non-empty
  name and the lender's terms together; a delete signs an empty name and no terms (`undefined`).
  Anything else, and invalid terms, is `bad-input`.

Lender terms, as JSON: terms are `{"pairs": [...]}` and a proposal one object, with the snake_case
field names of the core's `PairTerms` and `Proposal`, `u64` amounts as decimal strings, `u32`
fields as numbers and asset ids as display hex. An unknown or missing field, or a malformed value,
is `bad-input` naming the field.

- `encodeLenderTerms(termsJson)`, `decodeLenderTerms(hex)`: the encoding the directory stores and
  signs, and back. Terms the core's `LenderTerms::validate` rejects are `bad-input`.
- `checkProposal(termsJson, proposalJson)`: the names of the terms the proposal breaks
  (`TermBreach::name`, such as `AprBelowMinimum`), empty when it is within them.
- `minRepayment(principal, minAprBps, termBlocks)`, `minCollateral(principal,
  maxPrincipalPerCollateral)`, `aprBps(principal, repayment, termBlocks)`,
  `principalPerCollateral(principal, collateral)`: the core's arithmetic on `bigint` amounts; where
  the core has no value (a zero divisor, or a result above `u64::MAX`), `bad-input`. A `bigint`
  argument outside `u64` is wrapped by the JS boundary, so callers pass amounts in range.
