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

Directory:

- `signDirectoryAction(key, action, challengeHex, displayName)`: the Schnorr signature (hex) over a
  server challenge, with `DirectoryAction.Put` or `Delete`. A delete is signed over an empty name;
  a non-empty name is `bad-input`.
