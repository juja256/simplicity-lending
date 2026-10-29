# Private lending, part C1: wasm module and browser addresses — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The browser can run every private-offer cryptographic operation through a wasm module built from `private-lending-core`. It computes private-offer addresses with LWK, and a parity check proves them equal to Rust's on a real regtest offer.

**Architecture:**
- **The wasm crate.** A new crate, `crates/private-lending-wasm`, wraps the core with wasm-bindgen.
  - Its exported items return `Result<T, String>`, so the same code runs in native Rust tests.
  - `wasm-pack` builds it into `web/src/wasm/private-lending/`, which is git-ignored.
- **The browser.** It computes contract arguments in the wasm module, so byte orders stay in Rust. It turns them into addresses with LWK's `SimplicityProgram` (simplicityhl 0.4.1), as the public flows do.
- **The fixture.** A regtest test records a real private creation transaction, with its keys and expected scripts, as a fixture.
- **The checks.**
  - A Rust test checks the fixture against the contract.
  - A Node script checks the browser path, wasm plus LWK, against the same fixture.

**Tech Stack:** Rust 2024, wasm-bindgen 0.2, wasm-pack 0.15, getrandom 0.2 (`js`); TypeScript 5.9, Vite 7, `@lilbonekit/lwk-web` 0.17.2, tsx.

**Spec:** `docs/superpowers/specs/2026-10-28-private-lending-design.md`, sections "Keys and secrets", "Lender verification", "Building transactions in the browser" and "Testing" (parity test). The handoff, `docs/superpowers/handoff/2026-10-29-private-lending.md`, lists the rules part C must carry. Part C2 (flows and pages) builds on this plan's Interfaces blocks.

**Already established on this machine (2026-10-29):**
- A spike computed the pending-offer script pubkey of `private_lending.simf` with LWK in Node and with simplex in Rust, for the same arguments. Both gave `5120 23cd…f1d2`.
- `private-lending-core` builds for `wasm32-unknown-unknown` once `getrandom`'s `js` feature is on.
- The `wasm32-unknown-unknown` target and `wasm-pack` are installed. `web/node_modules` is installed with `npx pnpm@10.33.0 install --frozen-lockfile`.

## Global Constraints

- **Branch and commits.** Work on the branch `private-lending-wasm`, created from `main`. Each task ends with exactly one commit (message given in its last step), ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.
- **Crate dependencies.** `crates/private-lending-wasm` depends on `private-lending-core` (path), `wasm-bindgen = "0.2"`, `getrandom = { version = "0.2", features = ["js"] }`, and `elements = "0.25.2"`, which it uses only for parsing and printing. It has `crate-type = ["cdylib", "rlib"]` and `[lints] workspace = true`. Native tests may use dev-dependencies, including `lending-contracts` (path) and `serde_json`.
- **Errors.** No exported function builds a `JsValue` or `JsError`, because those panic outside wasm. Errors are `String`s of the form `<code>: <message>`. The codes:
  - **Not addressed to this key (skip silently):** `not-found`, `view-tag-mismatch`, `not-mine`, `rewind-failed`.
  - **Addressed to this key but invalid (show as invalid):** `terms-invalid`, `collateral-mismatch`, `invalid-terms`, `lender-nft-not-unique`, `nft-output-mismatch`.
  - **Bad caller input:** `bad-input`.
- **Formats across the wasm boundary.**
  - Txids and asset ids are display-order hex: `Display`/`FromStr` of `Txid` and `AssetId`, the same as LWK's `toString()`. Outpoints are `"<txid>:<vout>"`, as LWK's `OutPoint`.
  - Blinding factors use elements' `Display`/`FromStr` of `AssetBlindingFactor` and `ValueBlindingFactor`. This is the same big-endian hex as LWK's `AssetBlindingFactor.toString()`.
  - Keys, the nonce, the marker, commitment hashes, contract arguments, challenges and signatures are plain lowercase hex of their bytes. Hex inputs are accepted in either case, after trimming whitespace.
  - Amounts are `u64`, which is `bigint` in JS. PSETs are base64, as LWK's `Pset.toString()` and `new Pset(b64)`. Transactions are consensus-encoded hex.
- **Contract arguments.** These are the hex strings handed to `SimplicityTypedValue.fromU256Hex`. Each is the hex of the bytes that `PrivateLendingParameters::build_arguments` puts in the same field: `AssetId::into_inner().0` for NFT ids, and `PinnedOutput::commitment_hash()` for commitments. `LOAN_EXPIRATION_TIME` is a `u32`.
- **Private offer storage tree** (LWK): `new StateTaprootBuilder().addSimplicityLeaf(2, cmr).addDataLeaf(2, isActiveSlot).addDataLeaf(1, debtSlot).finalize(UNSPENDABLE_TAPROOT_PUBKEY)`.
  - `isActiveSlot` is 31 zero bytes followed by `0` (pending) or `1` (active).
  - `debtSlot` is the repayment commitment.
- **Output script hashes.**
  - `PRINCIPAL_OUTPUT_SCRIPT_HASH` is the script hash of asset_auth with (borrower NFT, 1, no burn).
  - `REPAYMENT_OUTPUT_SCRIPT_HASH` is the script hash of asset_auth with (lender NFT, 1, burn).
  - A script hash is `buildCovenantSpendInfo(program).scriptPubkey.jet_sha256_hex()`.
  - The lender NFT is locked at `loadScriptAuthProgram(<pending offer script hash>).createP2trAddress(UNSPENDABLE_TAPROOT_PUBKEY, network)`.
- **Witness `PATH`** (type `Either<Either<(), ()>, Either<Either<(), ()>, ()>>`):

  | Branch | Value |
  |---|---|
  | accept | `Left(Left(()))` |
  | cancel | `Left(Right(()))` |
  | partial repayment (reserved, always fails) | `Right(Left(Left(())))` |
  | full repayment | `Right(Left(Right(())))` |
  | liquidate | `Right(Right(()))` |
- **Lending key fingerprint.** The first 8 bytes of `tagged_hash("simplicity-lending/lending-key-fingerprint/v1", x_only_key)`, as 16 lowercase hex characters.
- **The generated wasm package.** It lives at `web/src/wasm/private-lending/`, is git-ignored, and is built by `pnpm build:wasm`:
  ```
  wasm-pack build ../crates/private-lending-wasm --release --target web --out-dir ../../web/src/wasm/private-lending --out-name private_lending_wasm
  ```
  Then delete the generated `.gitignore` and `package.json` there. `pnpm build`, `pnpm dev` and `pnpm lint` need the package.
- **The virtual module.** TS modules imported by the parity script must not import `virtual:simplicity-sources`, directly or transitively. Only `src/simplicity/*/program.ts` files bind the sources.
- **Before finishing any task:**
  - Rust: `cargo fmt --all`, and `SQLX_OFFLINE=true cargo clippy --workspace --all-targets --all-features -- -D warnings` is clean.
  - Web, when web files changed: run from `web/` with `npx pnpm@10.33.0`, for example `npx pnpm@10.33.0 lint`. `lint`, `format:check` and `build` must pass.
  - `crates/contracts` artifacts are built (`simplex build`).

## Review Focus

- **Descriptors without SLIP-77.** A wallet descriptor with no `slip77(...)` blinding key, such as a view-key `ct(...)` form or a bare `elwpkh(...)`, must fail with `bad-input`, never yield a key derived from garbage. Test: `descriptor_without_slip77_is_rejected` (Task 2).
- **Argument byte orders.** The wasm module's contract arguments must equal the contract's `build_arguments()` bytes for the same offer. Tests: `contract_arguments_match_the_contract` (Task 3, Rust), and the parity script (Task 5, LWK).
- **A view-tag collision for a wrong lender.** Opening must classify the offer as not addressed to this key, so it is skipped and never shown as an invalid offer. Test: `view_tag_collision_is_not_addressed_to_the_key` (Task 3).
- **Wallet coin secrets in LWK's string format.** Blinding factors arrive as `TxOutSecrets.assetBlindingFactor().toString()`. A byte-order slip here leaves the transaction unbalanced. Test: `blinding_with_display_format_secrets_balances` (Task 4).
- **A dishonest repayment commitment.** A creation transaction whose output 3 sits at an address for other contract arguments must fail the browser's address check. Test: the tampered-arguments case in the parity script (Task 5).

---

### Task 1: Parity fixture from a real regtest offer

**Files:**
- Create: `crates/contracts/tests/private_lending/parity_fixture.rs`, and `web/scripts/fixtures/private-lending-parity.json`, which the writer generates.
- Modify: `crates/contracts/tests/private_lending/mod.rs` (the module), and `crates/contracts/Cargo.toml` (dev-dependency `serde_json = "1"`).

**Interfaces:**
- Fixture JSON:

```json
{
  "borrower_master_blinding_key": "0101…01",
  "lender_master_blinding_key": "0202…02",
  "program_id": "<8 hex>",
  "creation_tx": "<consensus hex>",
  "arguments": {
    "borrower_nft_asset_id": "<64 hex>", "lender_nft_asset_id": "<64 hex>",
    "pending_collateral_commitment": "<64 hex>", "active_collateral_commitment": "<64 hex>",
    "principal_commitment": "<64 hex>", "repayment_commitment": "<64 hex>",
    "loan_expiration_time": 123
  },
  "principal_output_script_hash": "<64 hex>",
  "repayment_output_script_hash": "<64 hex>",
  "pending_offer_script_pubkey": "<hex>",
  "active_offer_script_pubkey": "<hex>",
  "lender_nft_script_pubkey": "<hex>"
}
```

- The arguments are hex of `PrivateLendingParameters::build_arguments()` fields, and the script pubkeys and hashes come from the contracts crate. The master blinding keys are the ones `setup_pending_private_offer` uses: `[1; 32]` for the borrower and `[2; 32]` for the lender.

- [ ] **Step 1: Write the writer test.** `write_private_lending_parity_fixture` is a `#[simplex::test]`.
  - It returns `Ok(())` immediately unless the env var `WRITE_PARITY_FIXTURE` is set.
  - Otherwise it runs `setup_pending_private_offer`, then `verify_offer_as_lender` on the creation transaction to get the parameters.
  - It writes the JSON, pretty-printed, to `concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/scripts/fixtures/private-lending-parity.json")`.
- [ ] **Step 2: Write the checker test.** `parity_fixture_verifies_against_the_contract` is a `#[simplex::test]` that uses no chain. It parses the fixture (`include_str!`) and checks:
  - `verify_offer_as_lender(lender, tx, network)` and `verify_offer_as_borrower(borrower, tx, network)` both succeed, with equal parameters.
  - Every `arguments` field, both output script hashes and all three script pubkeys equal the contract's values for those parameters (`new_pending`, `new_active`, `ScriptAuth::from_simplex_program(&pending)`).
  - `program_id` is the hex of `PrivateLendingOffer::get_program_id()`.
  - Output 3's script pubkey is `pending_offer_script_pubkey`, and output 1's is `lender_nft_script_pubkey`.
- [ ] **Step 3: Run** `cd crates/contracts && simplex test parity_fixture_verifies_against_the_contract`. Expected: FAIL, because the fixture file is missing.
- [ ] **Step 4: Generate the fixture** with `WRITE_PARITY_FIXTURE=1 simplex test write_private_lending_parity_fixture`, then re-run Step 3. Expected: PASS.
- [ ] **Step 5: Run** `simplex test --target private_lending --no-fail-fast`. Expected: all pass. The writer test passes as a no-op.
- [ ] **Step 6: Commit.** `git commit -m "private lending: parity fixture from a regtest offer"`

### Task 2: wasm crate, lending keys and scanning

**Files:**
- Create:
  - `crates/private-lending-wasm/Cargo.toml`
  - `crates/private-lending-wasm/src/{lib.rs,keys.rs,scan.rs,error.rs}`
  - `crates/private-lending-wasm/README.md`
- Modify:
  - `web/package.json`: script `build:wasm`.
  - `web/.gitignore`: `src/wasm/`.
  - `web/README.md`: prerequisites and `build:wasm`.
  - `deployment/Dockerfile.web`: a Rust stage that builds the package.

**Interfaces:**
- `error.rs`: `pub(crate) fn err(code: &str, message: impl Display) -> String`, plus `From`-style helpers mapping `CreationError`/`OpenError` to the codes in Global Constraints. Task 3 uses the helpers.
- `keys.rs` (`#[wasm_bindgen]`):
  - `pub struct LendingKey(private_lending_core::LendingKey)`, with:
    - `fromDescriptor(descriptor: &str) -> Result<LendingKey, String>`. It finds `slip77(` followed by 64 hex characters and `)`.
    - `fromMasterBlindingKey(hex: &str) -> Result<LendingKey, String>`
    - `xOnlyPublicKey(&self) -> String`
    - `fingerprint(&self) -> String`
  - `#[wasm_bindgen(js_name = keyFingerprint)] pub fn key_fingerprint(x_only_hex: &str) -> Result<String, String>`
  - `pub(crate) fn inner(&self) -> &private_lending_core::LendingKey`
- `scan.rs`:
  - `viewTagMatches(lender: &LendingKey, nonce_hex: &str, view_tag: u8) -> Result<bool, String>`: `OfferSecrets::for_lender(..).view_tag() == view_tag`.
  - `isOwnCandidate(borrower: &LendingKey, first_input: &str, borrower_nft: &str, lender_nft: &str, nonce_hex: &str) -> Result<bool, String>`: `ephemeral_key(..)·G == nonce`.
  - `privateLendingProgramId() -> String`: 8 hex. Compute it in `lib.rs` exactly as `SimplexProgram::get_program_id` does: the first 4 bytes of SHA-256 of the program source, with the source embedded via `include_str!("../../contracts/simf/private_lending.simf")`. If simplex's `SOURCE` differs from the raw file (for example by trimming), match it; the test below decides.
- Rust names are snake_case. JS names come from `#[wasm_bindgen(js_name = ...)]` and are as listed.

- [ ] **Step 1: Write the failing tests** (native, `#[cfg(test)]`):
  - `lending_key_from_descriptor_equals_the_master_blinding_key_derivation`
    - Use `ct(slip77(<hex of [7;32]>),elwpkh([d0c0ffee/84h/1h/0h]tpubD6NzVbkrYhZ4Y…/<0;1>/*))#abcd1234`. The tpub need not be valid; only `slip77` is read.
    - The resulting `xOnlyPublicKey()` equals `LendingKey::from_master_blinding_key(&[7; 32])`'s.
  - `descriptor_without_slip77_is_rejected`: `ct(02…,elwpkh(...))`, `elwpkh(...)`, `slip77(xyz)` and a 63-hex key all give `Err` starting with `bad-input:`.
  - `fingerprint_is_the_tagged_hash_prefix`: the key from `[1; 32]` (x-only `a9ddbd65…9762`, as the core's `lending_key_known_answers` pins it) has the fingerprint `"1aa05299d34bb9f5"`. Python's `hashlib` computed that value from the Global Constraints definition. `keyFingerprint` of the same x-only hex gives the same value.
  - `scanning_recognizes_the_fixture_offer`: parse `web/scripts/fixtures/private-lending-parity.json`, take the creation transaction's output 3 nonce, view tag (marker), first input and NFT ids, and check:
    - `viewTagMatches(lender, ..) == true`;
    - `isOwnCandidate(borrower, ..) == true`;
    - `isOwnCandidate(LendingKey from [3;32], ..) == false`.
  - `program_id_matches_the_contract`: equals the hex of `PrivateLendingOffer::get_program_id()` and the fixture's `program_id`.
- [ ] **Step 2: Run** `cargo test -p private-lending-wasm`. Expected: compile errors.
- [ ] **Step 3: Implement** the crate.
- [ ] **Step 4: Run** `cargo test -p private-lending-wasm`. Expected: 5 passed.
- [ ] **Step 5: Wire the build.**
  - Add `"build:wasm"` to `web/package.json`, with the command from Global Constraints, and run it. Expected: `web/src/wasm/private-lending/private_lending_wasm.{js,d.ts}` and `_bg.wasm` exist.
  - Add the `.gitignore` entry.
  - Add a `wasm` stage to `deployment/Dockerfile.web`:
    1. `FROM rust:1-bookworm`.
    2. `apt-get install -y clang`, `rustup target add wasm32-unknown-unknown`, `cargo install wasm-pack --locked`.
    3. Copy `Cargo.toml`, `Cargo.lock` and `crates/`, then run the same `wasm-pack build`.
    4. In the builder stage, copy `/app/web/src/wasm/private-lending` before `pnpm build`.
  - Document `build:wasm` and its prerequisites in `web/README.md`, and the API conventions in the crate README.
- [ ] **Step 6: Commit.** Clippy clean. `git commit -m "private-lending-wasm: lending keys and candidate scanning"`

### Task 3: Opening offers in wasm

**Files:**
- Create: `crates/private-lending-wasm/src/open.rs`

**Interfaces:**
- Consumes: Task 2 (`LendingKey`, error helpers).
- Produces (`#[wasm_bindgen]`):
  - `openCreationAsLender(lender: &LendingKey, creation_tx_hex: &str) -> Result<OpenedOffer, String>` and `openCreationAsBorrower(borrower: &LendingKey, creation_tx_hex: &str) -> Result<OpenedOffer, String>`. They call the core's `open_creation_as_*` with `privateLendingProgramId`, and map errors to the codes in Global Constraints.
  - `#[wasm_bindgen] pub enum PinnedRole { PendingCollateral, ActiveCollateral, Principal, Repayment }`
  - `pub struct OpenedOffer` with getters:
    - Terms: `principalAsset() -> String`, `principalAmount() -> u64`, `repaymentAmount() -> u64` and `interestRateBps() -> u16`. `interestRateBps` is display-only and never used for the interest (Ruling P8).
    - `loanExpirationTime() -> u32`, `borrowerNft() -> String`, `lenderNft() -> String`.
    - Keys: `borrowerPublicKey() -> String` and `lenderPublicKey() -> String`, both x-only hex.
    - Collateral: `collateralAsset() -> String` and `collateralAmount() -> u64`.
    - `firstInput() -> String`.
    - `contractArguments() -> ContractArguments`.
    - `pinned(role: PinnedRole) -> PinnedOutputInfo`.
  - `pub struct ContractArguments`, with getters `borrowerNftAssetId`, `lenderNftAssetId`, `pendingCollateralCommitment`, `activeCollateralCommitment`, `principalCommitment` and `repaymentCommitment` (all `String`, 64 hex), plus `loanExpirationTime() -> u32`.
  - `pub struct PinnedOutputInfo`, with getters `asset() -> String`, `amount() -> u64`, `assetBlinder() -> String`, `valueBlinder() -> String`, `assetCommitment() -> String` and `valueCommitment() -> String`. The commitments are the consensus-encoded hex of `confidential::Asset` and `confidential::Value`.
  - Rust-only: `pub(crate) fn inner(&self) -> &private_lending_core::OpenedOffer`, for Task 4.

- [ ] **Step 1: Write the failing tests** against the fixture:
  - `lender_and_borrower_open_the_fixture_offer`
    - Both succeed, with equal `contractArguments`.
    - `lenderPublicKey()` is the lender's x-only key.
    - `repaymentAmount() >= principalAmount()`.
  - `contract_arguments_match_the_contract`: every `ContractArguments` field equals the hex of the matching field of `verify_offer_as_lender(..).1.build_arguments()`, using the contracts crate as a dev-dependency.
  - `pinned_outputs_match_the_creation_transaction`
    - `pinned(PendingCollateral)`'s commitments equal output 3's asset and value commitments.
    - Its asset and amount equal `collateralAsset()` and `collateralAmount()`.
  - `view_tag_collision_is_not_addressed_to_the_key`: loop over `[i; 32]` keys until one's view tag equals the marker's but it isn't the lender. `openCreationAsLender` fails with a code in the not-addressed group: `rewind-failed` or `view-tag-mismatch`.
  - `stranger_cannot_open_as_borrower`: the error code is `not-mine`.
  - `malformed_transaction_hex_is_bad_input`: `"zz"` and a truncated transaction both fail with `bad-input`.
- [ ] **Step 2: Run** `cargo test -p private-lending-wasm open`. Expected: FAIL.
- [ ] **Step 3: Implement** `open.rs`.
- [ ] **Step 4: Run** `cargo test -p private-lending-wasm`. Then run `npx pnpm@10.33.0 build:wasm` in `web/`. Expected: all tests pass and the build succeeds.
- [ ] **Step 5: Commit.** `git commit -m "private-lending-wasm: open and check offers"`

### Task 4: Building and blinding in wasm

**Files:**
- Create: `crates/private-lending-wasm/src/{build.rs,blind.rs,directory.rs}`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces (`#[wasm_bindgen]`):
  - `pub struct OfferTermsInput`, a constructor-only input. It takes `new(principal_asset: &str, principal_amount: u64, repayment_amount: u64, interest_rate_bps: u16, loan_expiration_time: u32, borrower_nft: &str, lender_nft: &str) -> Result<OfferTermsInput, String>`.
  - `pub struct NewOffer`. Its constructor is `build(borrower: &LendingKey, lender_x_only: &str, first_input: &str, collateral_asset: &str, collateral_amount: u64, terms: &OfferTermsInput) -> Result<NewOffer, String>`. Core `OfferError` values map to `bad-input`. Getters:
    - `marker() -> String`, the 37-byte payload hex for `Script.newOpReturn`.
    - `contractArguments() -> ContractArguments` and `pinned(role) -> PinnedOutputInfo`.
    - `collateralBlinding(output_index: u32) -> PinnedBlinding`.
    - `lenderPublicKey() -> String`.
  - `issuedAssetId(outpoint: &str, contract_hash: &str) -> Result<String, String>`: `AssetId::from_entropy(AssetId::generate_asset_entropy(outpoint, ContractHash::from_str(contract_hash)))`. It gives the NFT ids before the transaction exists. `contract_hash` uses `ContractHash`'s `Display` format.
  - `pub struct PinnedBlinding`, an opaque handle wrapping the core's `PinnedBlinding`. `OpenedOffer` gains `pinnedBlinding(role: PinnedRole, output_index: u32) -> PinnedBlinding` for outputs created at acceptance or repayment, with no ephemeral key and no extra data.
  - `pub struct InputSecret`:
    - `new(input_index: u32, asset: &str, asset_blinder: &str, value: u64, value_blinder: &str) -> Result<InputSecret, String>`
    - `explicit(input_index: u32, asset: &str, value: u64) -> Result<InputSecret, String>`
    - `OpenedOffer` gains `inputSecret(role: PinnedRole, input_index: u32) -> InputSecret`, the secrets of a covenant input.
  - `blindPset(pset_base64: &str, input_secrets: Vec<InputSecret>, blindings: Vec<PinnedBlinding>) -> Result<String, String>`. It calls the core's `blind_pset` with `rand::thread_rng()` and returns base64.
  - `#[wasm_bindgen] pub enum DirectoryAction { Put, Delete }`, and `signDirectoryAction(key: &LendingKey, action: DirectoryAction, challenge_hex: &str, display_name: &str) -> Result<String, String>`, which returns 64-byte signature hex.

- [ ] **Step 1: Write the failing tests:**
  - `new_offer_round_trips_through_opening`
    - Build a `NewOffer` with fixture-like inputs. Blind a PSET whose output 3 uses `collateralBlinding(3)`. Assemble the transaction as the core's creation tests do; copy the helper into a test module, since it is not public.
    - `openCreationAsLender` returns the same `contractArguments`.
  - `blinding_with_display_format_secrets_balances`
    - Use a PSET with one confidential wallet input. Its `InputSecret` is built from `AssetBlindingFactor::to_string()` and `ValueBlindingFactor::to_string()` of known factors.
    - Blind one pinned output and a change output.
    - `verify_tx_amt_proofs` succeeds on the extracted transaction.
  - `issued_asset_id_matches_elements`: `issuedAssetId` equals elements' computation for the same outpoint and contract hash.
  - `directory_signature_verifies`: `verify_directory_action` from the core accepts the signature for `Put`, "Acme Bank" and a fixed challenge.
  - `bad_inputs_are_rejected`: each case returns `bad-input`:
    - a PSET that isn't base64;
    - an `InputSecret` with a 31-byte blinder;
    - `OfferTermsInput` with a principal of 0.
- [ ] **Step 2: Run** `cargo test -p private-lending-wasm build blind directory`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test -p private-lending-wasm`, then `npx pnpm@10.33.0 build:wasm` in `web/`. Expected: all tests pass and the build succeeds.
- [ ] **Step 5: Commit.** `git commit -m "private-lending-wasm: build offers, blind PSETs, sign directory actions"`

### Task 5: Browser addresses with LWK, proven by the parity check

**Files:**
- Create:
  - `web/src/simplicity/asset-auth/arguments.ts` and `web/src/simplicity/script-auth/arguments.ts`, which receive the moved argument builders.
  - `web/src/simplicity/private-lending/scripts.ts`, pure, taking sources as input.
  - `web/src/simplicity/private-lending/program.ts`, which binds the virtual sources.
  - `web/src/privateLending/wasm.ts`, the loader.
  - `web/scripts/check-private-lending-parity.ts`
- Modify:
  - `web/src/simplicity/asset-auth/program.ts` and `web/src/simplicity/script-auth/program.ts`: import and re-export the moved builders.
  - `web/simplicity-covenants.config.json`: add `{ "id": "private_lending", "path": "../crates/contracts/simf/private_lending.simf" }`.
  - `web/package.json`: script `"parity": "tsx --tsconfig tsconfig.app.json scripts/check-private-lending-parity.ts"`.
  - `web/README.md`

**Interfaces:**
- Consumes: Tasks 1–4. The fixture, and the wasm API: `ContractArguments`, `OpenedOffer`, `LendingKey`, `openCreationAs*`, `viewTagMatches`, `isOwnCandidate`, `privateLendingProgramId`.
- Produces:
  - `scripts.ts`:
    - `export interface PrivateLendingSources { privateLending: string; assetAuth: string; scriptAuth: string }`
    - `export interface PrivateOfferArguments { borrowerNftAssetId: string; lenderNftAssetId: string; pendingCollateralCommitment: string; activeCollateralCommitment: string; principalCommitment: string; repaymentCommitment: string; loanExpirationTime: number }`
    - `export function toPrivateOfferArguments(args: ContractArguments): PrivateOfferArguments`, which copies the wasm getters.
    - `export interface PrivateOfferScripts { pendingOffer: Script; activeOffer: Script; lenderNftLock: Script; principalOutputScriptHash: string; repaymentOutputScriptHash: string; pendingSpendInfo: StateTaprootSpendInfo; activeSpendInfo: StateTaprootSpendInfo; program: SimplicityProgram }`
    - `export function privateOfferScripts(sources: PrivateLendingSources, args: PrivateOfferArguments, network: Network): PrivateOfferScripts`
    - `export function verifyOfferAddresses(scripts: PrivateOfferScripts, creationTx: Transaction): boolean`: output 3's script equals `pendingOffer`, and output 1's equals `lenderNftLock`.
  - `program.ts`:
    - `export function loadPrivateOfferScripts(args: PrivateOfferArguments, network: Network): PrivateOfferScripts`, bound to `virtual:simplicity-sources`.
    - `export type PrivateLendingBranch = 'OfferAcceptance' | 'OfferCancellation' | 'FullRepayment' | 'Liquidation'`
    - `export function buildPrivateLendingWitness(branch: PrivateLendingBranch): SimplicityWitnessValues`, with the `PATH` values from Global Constraints.
  - `wasm.ts`: `export async function getPrivateLendingWasm(): Promise<typeof import('@/wasm/private-lending/private_lending_wasm')>`, initialized once, like `getLwk`.
  - `pnpm parity`
    1. It inits LWK and the wasm module in Node with their `.wasm` bytes, and reads the three `.simf` sources from `crates/contracts/simf`, trimmed as the Vite plugin does.
    2. It runs these checks, printing each and exiting 1 on the first mismatch:
       1. `privateLendingProgramId()` equals `program_id`.
       2. `viewTagMatches` and `isOwnCandidate` are true for the fixture keys.
       3. As lender and as borrower, `contractArguments` equal the fixture's `arguments`.
       4. `privateOfferScripts` gives exactly the fixture's three script pubkeys and two output script hashes.
       5. `verifyOfferAddresses(scripts, creationTx)` is true.
       6. **Tampered case:** after the last hex digit of `repaymentCommitment` is changed, `verifyOfferAddresses` is false.
    3. If every check passes, it prints `private lending parity: ok`.

- [ ] **Step 1: Write the parity script first, against the interfaces above.** Run `npx pnpm@10.33.0 parity` in `web/`. Expected: it fails because the imports are missing.
- [ ] **Step 2: Move the argument builders.** Move `buildAssetAuthArguments` (with `AssetAuthProgramParams`) and `buildScriptAuthArguments` into `arguments.ts` files. `program.ts` re-exports them, so existing imports keep working.
- [ ] **Step 3: Implement** `scripts.ts`, `program.ts` and `wasm.ts`, and add the covenant config entry. Follow `src/simplicity/lending/program.ts`, with the storage tree, script hashes and `PATH` from Global Constraints.
- [ ] **Step 4: Run** `npx pnpm@10.33.0 parity`. Expected: `private lending parity: ok`, including the tampered case.
- [ ] **Step 5: Run** `npx pnpm@10.33.0 lint`, `npx pnpm@10.33.0 format:check` and `npx pnpm@10.33.0 build`. Expected: all pass, and public pages are unchanged in behaviour.
- [ ] **Step 6: Document** `pnpm parity` in `web/README.md`: what it proves, and that it must pass before C2 relies on browser addresses.
- [ ] **Step 7: Commit.** `git commit -m "web: private offer addresses with LWK, checked against Rust"`
