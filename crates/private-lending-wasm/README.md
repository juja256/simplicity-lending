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
- A transaction given as a loan's acceptance, installment or close that is not the loan's:
  `loan-mismatch`, naming the acceptance or the installment (from 1).
- Bad caller input: `bad-input`.

The borrower's pre-broadcast self-check of an offer it just built must treat every code as fatal.

### Validity

A successful `openCreationAsLender` / `openCreationAsBorrower` does not make an offer valid: the
terms and the collateral are checked, but not the addresses. The address check,
`verifyOfferAddresses` in `web/src/simplicity/private-lending/scripts.ts`, must also pass.

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
  offer into an `OpenedOffer`.
- `OpenedOffer` getters: `principalAsset`, `principalAmount`, `repaymentAmount`, `interestRateBps`,
  `loanExpirationTime`, `borrowerNft`, `lenderNft`, `borrowerPublicKey`, `lenderPublicKey`,
  `collateralAsset`, `collateralAmount`, `firstInput`.
- `OpenedOffer.borrowerBlindingKey()`, `OpenedOffer.lenderBlindingKey()`: the lifted keys.
- `OpenedOffer.contractArguments()`: the `ContractArguments` of the offer's contract.
- `OpenedOffer.pinned(role)`: the `PinnedOutputInfo` (asset, amount, blinders, commitments) of a
  `PinnedRole`.

Building and blinding:

- `OfferTermsInput`, `NewOffer.build(...)`: validate terms and build an offer; `marker()`,
  `contractArguments()`, `pinned(role)`, `lenderPublicKey()`.
- `NewOffer.collateralBlinding(outputIndex)`, `NewOffer.collateralBlindingKey()`: how and to which
  key to blind the creation's collateral output.
- `issuedAssetId(outpoint, contractHash)`: the id of an asset before its issuing transaction exists.
- `OpenedOffer.pinnedBlinding(role, outputIndex)`: how to blind a pinned output of acceptance or
  repayment (`bad-input` for the pending collateral, which only creation blinds).
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
  Each installment must spend the previous loan output at input 1, hold the collateral after it
  at output 1 and pay `A` at output 2. The scripts are the caller's to check, against
  `activeOfferAt(state.debtHashAt(j))` in `web/src/simplicity/private-lending/scripts.ts`.
- `LoanState` getters: `installmentCount`, `loanOutpoint`, `debtCommitment`, `debtHash`, `paid`
  (what opened for the party) and `remaining` (`undefined` unless every installment opened);
  `debtHashAt(j)` (0 the acceptance's loan output), `installment(j)` (from 1),
  `loanInputSecret(inputIndex)` and `collateral()`.
- Borrower only, else `bad-input`: `planInstallment(amount, firstWalletInput,
  nftReceiverScript)`, an `InstallmentPlan` (`debtWitness`, `successorDebtHash`, `installment`,
  `installmentBlinding(i)`, `successorBlinding(i)`) for an amount above 0 and below the
  remaining debt; `repaymentBlinding(i)` while an amount is owed; `zeroDebtKey()` once none is.
- Lender only, else `bad-input`: `sweep(closeTxHex, unspent)`, the `Sweep` (`outpoints()`,
  `amount`, `inputSecret(position, inputIndex)`) of the final claim after the full repayment or
  the zero-debt close, or of a liquidation when `closeTxHex` is `undefined`.

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
