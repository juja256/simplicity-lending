# Private lending, part A: crypto core and contract v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A wasm-ready Rust crate with every piece of private-offer cryptography (keys, per-offer secrets, terms, marker, pinned blinding, opening), and contract v1 built on it, proven on regtest through every phase.

**Architecture:** A new crate `crates/private-lending-core` depends only on `elements` 0.25.2 and `rand` 0.8, so part C can compile it to wasm unchanged. The contracts crate keeps everything that needs simplex (programs, addresses, transactions) and calls the core for the cryptography. The PSET blinding moves out of `utils/confidential.rs` into the core, so regtest tests and the browser run the same code.

**Tech Stack:** Rust 2024 edition, elements 0.25.2 / secp256k1-zkp, SimplicityHL (simplex 0.0.5), regtest via `simplex test`.

**Spec:** `docs/superpowers/specs/2026-10-28-private-lending-design.md`. Parts B (indexer) and C (wasm module and front end) get their own plans and rely on this plan's Interfaces blocks.

## Global Constraints

- `private-lending-core` depends on `elements = "0.25.2"` and `rand = "0.8"` only: no simplex, no ring, no I/O.
- Tagged hash: `SHA256(SHA256(tag) ‖ SHA256(tag) ‖ data)` (BIP340 style).
- Tags, verbatim: `simplicity-lending/lending-key/v1`, `simplicity-lending/private/v1/ephemeral`, and `simplicity-lending/private/v1/<label>` for the labels `view-tag`, `lender-key-pad`, `offer`, `pending-collateral-abf`, `pending-collateral-vbf`, `active-collateral-abf`, `active-collateral-vbf`, `principal-abf`, `principal-vbf`, `repayment-abf`, `repayment-vbf`.
- Lending keys are normalized to even Y; the x-only key is used for BIP340 and, lifted with even Y, for ECDH.
- Shared secret = Elements' `Nonce::with_ephemeral_sk` / `Nonce::shared_secret` value.
- Range proofs: min value 1, exp 0, 52 min bits, script pubkey as extra commit, the output's asset generator as additional generator; message = asset id ‖ asset blinder ‖ extra data.
- Terms v1: big-endian, 217 bytes: version `1` (1) ‖ length `214` (2) ‖ principal asset (32) ‖ principal amount (8) ‖ repayment amount (8) ‖ interest bps (2) ‖ expiration height (4) ‖ borrower NFT (32) ‖ lender NFT (32) ‖ borrower x-only key (32) ‖ BIP340 signature (64). The signature signs `tagged_hash(offer, lender_pk ‖ first_input_txid ‖ first_input_vout_le32 ‖ bytes 0..153)`.
- Marker: 37 bytes, `program_id (4) ‖ view_tag (1) ‖ encrypted_lender_key (32)`.
- Creation layout: inputs 0 and 1 are borrower coins issuing the borrower NFT and the lender NFT (amount 1, no reissuance token); outputs 0 borrower NFT → borrower, 1 lender NFT → script_auth(offer), 2 marker, 3 pending offer; change and fee follow. "First input" = input 0's outpoint.
- No protocol fee anywhere in the private contract.
- Work on the branch `private-lending-v1`. Each task ends with exactly one commit (message given in its last step), ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.
- Before finishing any task: `cargo clippy --workspace --all-targets --all-features -- -D warnings` is clean (after `simplex build` in `crates/contracts` when `.simf` files changed).

## Review Focus

- A borrower whose collateral coins are confidential (every real wallet): blinding must use their unblinded secrets. Test: `blind_pset_with_confidential_wallet_input` (Task 4).
- A master blinding key whose derived key has odd Y: borrower (holding only the x-only key) and lender must reach the same shared secret. Test: `odd_y_lending_key_agrees_on_shared_secret` (Task 1).
- A wrong lender whose view tag collides (1 in 256): opening must fail cleanly, not panic or accept. Test: `view_tag_collision_with_wrong_key_is_rejected` (Task 5).
- Zero amounts or a repayment below the principal: building the offer must refuse, since confidential amounts must be at least 1. Test: `build_rejects_invalid_amounts` (Task 5).
- A pending collateral blinded with other blinders than the derived ones (buggy or dishonest borrower): opening must report a mismatch. Test: `collateral_with_foreign_blinders_is_rejected` (Task 5).

---

### Task 1: Core crate, lending keys and per-offer secrets

**Files:**
- Create: `crates/private-lending-core/Cargo.toml`, `crates/private-lending-core/src/lib.rs`, `crates/private-lending-core/src/keys.rs`, `crates/private-lending-core/src/secrets.rs`

**Interfaces:**
- Produces:
  - `pub fn tagged_hash(tag: &str, data: &[&[u8]]) -> [u8; 32]` (`lib.rs`)
  - `pub struct LendingKey` with `from_master_blinding_key(mbk: &[u8; 32]) -> LendingKey`, `secret_key(&self) -> SecretKey`, `x_only_public_key(&self) -> XOnlyPublicKey`
  - `pub fn lift_lending_key(key: &XOnlyPublicKey) -> PublicKey` (even Y)
  - `pub fn ephemeral_key(borrower: &LendingKey, first_input: &OutPoint, borrower_nft: AssetId, lender_nft: AssetId) -> SecretKey` — `tagged_hash("simplicity-lending/private/v1/ephemeral", borrower_sk ‖ txid ‖ vout_le32 ‖ borrower_nft ‖ lender_nft)`, txid and asset ids in internal byte order (final-review Ruling F1)
  - `pub struct OfferSecrets` with `for_borrower(ephemeral_sk: &SecretKey, lender: &XOnlyPublicKey) -> OfferSecrets`, `for_lender(lender: &LendingKey, nonce: &PublicKey) -> OfferSecrets`, `shared_secret(&self) -> SecretKey`, `view_tag(&self) -> u8`, `blinders(&self, role: PinnedRole) -> (AssetBlindingFactor, ValueBlindingFactor)`, `derive(&self, label: &str) -> [u8; 32]`
  - `pub enum PinnedRole { PendingCollateral, ActiveCollateral, Principal, Repayment }`
  - Types are elements 0.25's (`elements::secp256k1_zkp::{SecretKey, PublicKey, XOnlyPublicKey}`, `elements::{AssetId, OutPoint, confidential::{AssetBlindingFactor, ValueBlindingFactor}}`).

- [ ] **Step 1: Write the failing tests** in `src/keys.rs` and `src/secrets.rs` (`#[cfg(test)]`):

```rust
#[test]
fn lending_key_is_deterministic_and_even() {
    let a = LendingKey::from_master_blinding_key(&[7; 32]);
    let b = LendingKey::from_master_blinding_key(&[7; 32]);
    assert_eq!(a.secret_key(), b.secret_key());
    assert_eq!(lift_lending_key(&a.x_only_public_key()),
               PublicKey::from_secret_key(SECP256K1, &a.secret_key()));
}

#[test]
fn odd_y_lending_key_agrees_on_shared_secret() {
    // find a master blinding key whose raw tagged hash has an odd-Y public key
    let mbk = (0u8..=255).map(|i| [i; 32]).find(|m| raw_key_has_odd_y(m)).unwrap();
    let lender = LendingKey::from_master_blinding_key(&mbk);
    let e = SecretKey::from_slice(&[3; 32]).unwrap();
    let borrower_side = OfferSecrets::for_borrower(&e, &lender.x_only_public_key());
    let nonce = PublicKey::from_secret_key(SECP256K1, &e);
    assert_eq!(borrower_side.shared_secret(), OfferSecrets::for_lender(&lender, &nonce).shared_secret());
}

#[test]
fn both_sides_derive_the_same_view_tag_and_blinders() {
    let (borrower_side, lender_side) = both_sides(&[9; 32]); // helper: secrets as in the test above
    assert_eq!(borrower_side.view_tag(), lender_side.view_tag());
    for role in ALL_ROLES {
        assert_eq!(borrower_side.blinders(role), lender_side.blinders(role));
    }
}

#[test]
fn ephemeral_key_depends_on_first_input() {
    let borrower = LendingKey::from_master_blinding_key(&[1; 32]);
    let a = OutPoint::new(Txid::all_zeros(), 0);
    let b = OutPoint::new(Txid::all_zeros(), 1);
    assert_eq!(ephemeral_key(&borrower, &a), ephemeral_key(&borrower, &a));
    assert_ne!(ephemeral_key(&borrower, &a), ephemeral_key(&borrower, &b));
}

#[test]
fn derived_labels_are_distinct() {
    let (secrets, _) = both_sides(&[9; 32]);
    let all: HashSet<_> = ALL_ROLES.iter().flat_map(|r| {
        let (abf, vbf) = secrets.blinders(*r);
        [abf.into_inner().secret_bytes(), vbf.into_inner().secret_bytes()]
    }).collect();
    assert_eq!(all.len(), 8);
}
```

(`raw_key_has_odd_y` is a test helper computing `tagged_hash("simplicity-lending/lending-key/v1", [m])` and checking the parity.)

- [ ] **Step 2: Run** `cargo test -p private-lending-core` — Expected: compile errors (types missing).

- [ ] **Step 3: Implement** the crate. `Cargo.toml`: `edition.workspace = true`, `license.workspace = true`, deps `elements = "0.25.2"`, `rand = "0.8"`. `LendingKey::from_master_blinding_key`: the tagged hash mod n (`SecretKey::from_slice`; a zero/overflow hash cannot occur in practice, so `expect` with a message), negated if its public key has odd Y. `ephemeral_key`: tagged hash of `borrower_sk ‖ txid bytes ‖ vout_le32`. `blinders`: abf from label `<role>-abf`, vbf from `<role>-vbf` (`AssetBlindingFactor::from_slice`, `ValueBlindingFactor::from_slice`). `view_tag`: first byte of `derive("view-tag")`.

- [ ] **Step 4: Run** `cargo test -p private-lending-core` — Expected: 5 passed.

- [ ] **Step 5: Commit** — clippy clean; `git add crates/private-lending-core Cargo.lock && git commit -m "private-lending-core: lending keys and per-offer secrets"`

### Task 2: Terms encoding and borrower signature

**Files:**
- Create: `crates/private-lending-core/src/terms.rs`

**Interfaces:**
- Consumes: `tagged_hash`, `LendingKey` (Task 1).
- Produces:
  - `pub struct OfferTerms { pub principal_asset: AssetId, pub principal_amount: u64, pub repayment_amount: u64, pub interest_rate_bps: u16, pub loan_expiration_time: u32, pub borrower_nft: AssetId, pub lender_nft: AssetId }`
  - `pub struct SignedTerms { pub terms: OfferTerms, pub borrower: XOnlyPublicKey, pub signature: schnorr::Signature }`
  - `SignedTerms::sign(terms: OfferTerms, borrower: &LendingKey, lender: &XOnlyPublicKey, first_input: &OutPoint) -> SignedTerms`
  - `SignedTerms::verify(&self, lender: &XOnlyPublicKey, first_input: &OutPoint) -> Result<(), TermsError>`
  - `SignedTerms::encode(&self) -> Vec<u8>` (217 bytes), `SignedTerms::decode(bytes: &[u8]) -> Result<SignedTerms, TermsError>`
  - `pub const TERMS_VERSION: u8 = 1;` `pub enum TermsError { UnknownVersion(u8), BadLength, BadSignature, Malformed }`

- [ ] **Step 1: Write the failing tests:**

```rust
#[test]
fn terms_round_trip_with_zero_padding() {
    let signed = sample_signed();
    let mut bytes = signed.encode();
    assert_eq!(bytes.len(), 217);
    bytes.extend_from_slice(&[0u8; 3000]); // rewind returns the message padded with zeros
    assert_eq!(SignedTerms::decode(&bytes).unwrap(), signed);
}

#[test]
fn signature_binds_lender_and_first_input() {
    let signed = sample_signed(); // signed for LENDER and OUTPOINT_A
    assert!(signed.verify(&LENDER, &OUTPOINT_A).is_ok());
    assert!(matches!(signed.verify(&OTHER_LENDER, &OUTPOINT_A), Err(TermsError::BadSignature)));
    assert!(matches!(signed.verify(&LENDER, &OUTPOINT_B), Err(TermsError::BadSignature)));
}

#[test]
fn tampered_amount_fails_verification() {
    let mut signed = sample_signed();
    signed.terms.repayment_amount -= 1;
    assert!(matches!(signed.verify(&LENDER, &OUTPOINT_A), Err(TermsError::BadSignature)));
}

#[test]
fn unknown_version_and_short_input_are_rejected() {
    let mut bytes = sample_signed().encode();
    bytes[0] = 2;
    assert!(matches!(SignedTerms::decode(&bytes), Err(TermsError::UnknownVersion(2))));
    assert!(matches!(SignedTerms::decode(&bytes[..100]), Err(TermsError::BadLength)));
}
```

- [ ] **Step 2: Run** `cargo test -p private-lending-core terms` — Expected: FAIL (missing types).
- [ ] **Step 3: Implement** per the Global Constraints layout; `decode` reads the length field and ignores bytes after it. Sign with `secp.sign_schnorr_with_aux_rand` over the tagged message with a random aux, verify with `verify_schnorr`.
- [ ] **Step 4: Run** `cargo test -p private-lending-core` — Expected: all pass.
- [ ] **Step 5: Commit** — `git commit -m "private-lending-core: terms encoding and borrower signature"` (stage only this task's files)

### Task 3: Marker

**Files:**
- Create: `crates/private-lending-core/src/marker.rs`

**Interfaces:**
- Consumes: `tagged_hash`, `LendingKey`, `OfferSecrets` (Task 1).
- Produces: `pub struct Marker { pub program_id: [u8; 4], pub view_tag: u8, pub encrypted_lender_key: [u8; 32] }` with `Marker::new(program_id: [u8; 4], secrets: &OfferSecrets, lender: &XOnlyPublicKey, borrower: &LendingKey, first_input: &OutPoint, borrower_nft: AssetId, lender_nft: AssetId) -> Marker`, `encode(&self) -> [u8; 37]`, `decode(bytes: &[u8]) -> Option<Marker>` (exactly 37 bytes), `decrypt_lender_key(&self, borrower: &LendingKey, first_input: &OutPoint, borrower_nft: AssetId, lender_nft: AssetId) -> Option<XOnlyPublicKey>`. The pad is `tagged_hash("simplicity-lending/private/v1/lender-key-pad", borrower_sk ‖ txid ‖ vout_le32 ‖ borrower_nft ‖ lender_nft)` (Rulings P2, F1).

- [ ] **Step 1: Write the failing tests:** `marker_round_trips` (encode → decode equal; `decode` of 36 or 38 bytes is `None`); `borrower_decrypts_lender_key` (equals the lender's x-only key); `other_borrower_gets_another_key` (a different borrower key yields `None` or a different key, never the lender's); `view_tag_matches_secrets` (`marker.view_tag == secrets.view_tag()`).
- [ ] **Step 2: Run** `cargo test -p private-lending-core marker` — Expected: FAIL.
- [ ] **Step 3: Implement.** Pad = `derive`-style tagged hash with label `lender-key-pad` over `borrower_sk ‖ txid ‖ vout_le32`; XOR with the x-only key bytes; `decrypt_lender_key` returns `XOnlyPublicKey::from_slice(..).ok()`.
- [ ] **Step 4: Run** `cargo test -p private-lending-core` — Expected: all pass.
- [ ] **Step 5: Commit** — `git commit -m "private-lending-core: offer marker"`

### Task 4: Pinned outputs, PSET blinding with extra data, rewind

**Files:**
- Create: `crates/private-lending-core/src/pinned.rs`, `crates/private-lending-core/src/blind.rs`
- Modify: `crates/contracts/Cargo.toml` (add `private-lending-core = { path = "../private-lending-core" }`), `crates/contracts/src/utils/confidential.rs` (move `PinnedOutput` out, call `blind_pset`)

**Interfaces:**
- Produces:
  - `pub struct PinnedOutput { pub asset_id: AssetId, pub amount: u64, pub asset_blinding_factor: AssetBlindingFactor, pub value_blinding_factor: ValueBlindingFactor }` with `asset_commitment(&self) -> confidential::Asset`, `value_commitment(&self) -> confidential::Value`, `commitment_hash(&self) -> [u8; 32]`, `matches(&self, txout: &TxOut) -> bool`, `secrets(&self) -> TxOutSecrets` (same semantics as today's `utils::confidential::PinnedOutput`)
  - `pub struct PinnedBlinding { pub output_index: usize, pub pinned: PinnedOutput, pub ephemeral_sk: Option<SecretKey>, pub extra_data: Vec<u8> }`
  - `pub fn blind_pset<R: RngCore + CryptoRng>(pset: &mut PartiallySignedTransaction, input_secrets: &HashMap<usize, TxOutSecrets>, pinned: &[PinnedBlinding], rng: &mut R) -> Result<(), BlindPsetError>`
  - `pub fn rewind(txout: &TxOut, shared_secret: SecretKey) -> Result<(TxOutSecrets, Vec<u8>), RewindError>` (the extra data, zero-padded)
  - contracts keeps `PinnedOutput::new_random` and `to_utxo` as an extension trait `PinnedOutputExt` in `utils/confidential.rs`, and re-exports `PinnedOutput`.

- [ ] **Step 1: Write the failing tests** in `blind.rs`:
  - `pinned_output_rewinds_with_extra_data`: a PSET with one explicit input (known secrets) and outputs: a pinned output with `ephemeral_sk = Some(e)`, `extra_data = b"terms".to_vec()`, a confidential change, an explicit fee. After `blind_pset`, `rewind(&tx.output[0], OfferSecrets-equivalent shared secret)` returns the pinned secrets and extra data starting with `b"terms"` followed by zeros; `tx.output[0].nonce` equals `e·G`; `pinned.matches(&tx.output[0])`.
  - `pinned_outputs_carry_blind_proofs`: every blinded PSET output has `blind_value_proof` and `blind_asset_proof` that verify (`blind_value_proof_verify`, `blind_asset_proof_verify`) and a `blinding_key`.
  - `blinded_transaction_balances`: `tx.verify_tx_amt_proofs(&secp, &spent_utxos)` succeeds, with two pinned outputs in one PSET.
  - `blind_pset_with_confidential_wallet_input`: same as the first, but the input is a confidential UTXO whose secrets are passed in `input_secrets`.
- [ ] **Step 2: Run** `cargo test -p private-lending-core blind` — Expected: FAIL.
- [ ] **Step 3: Implement `blind_pset`** by moving the pinned-output loop and `blind_last` call out of `ConfidentialTransaction::finalize_with_fee`, with three changes: the range proof is built with `RangeProof::new` and the message `asset ‖ abf ‖ extra_data` (parameters from Global Constraints); the nonce uses `ephemeral_sk` when given, else a random key; each pinned output also gets `blind_value_proof` / `blind_asset_proof` (`elements::blind::{BlindValueProofs, BlindAssetProofs}`) and keeps explicit `asset`/`amount`. Keep the global-scalar correction exactly as today. `rewind` uses `RangeProof::rewind` with the same parameters and splits the message at 64.
- [ ] **Step 4: Switch `finalize_with_fee`** to build `PinnedBlinding`s from its `pinned_outputs` and call `blind_pset`. `add_pinned_output(script, pinned, recipient_blinding_key)` keeps working (no ephemeral key, no extra data); add `add_pinned_output_with(script, pinned, recipient_blinding_key, ephemeral_sk: SecretKey, extra_data: Vec<u8>)`.
- [ ] **Step 5: Run** `cargo test -p private-lending-core` (all pass), then `cd crates/contracts && simplex build && simplex test --target private_lending --no-fail-fast` — Expected: the existing 8 private lending tests still pass.
- [ ] **Step 6: Commit** — `git commit -m "private-lending-core: pinned blinding with range proof extra data"`

### Task 5: Building and opening offers

**Files:**
- Create: `crates/private-lending-core/src/offer.rs`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `pub struct OfferPinned { pub pending_collateral: PinnedOutput, pub active_collateral: PinnedOutput, pub principal: PinnedOutput, pub repayment: PinnedOutput }` with `OfferPinned::derive(secrets: &OfferSecrets, collateral_asset: AssetId, collateral_amount: u64, terms: &OfferTerms) -> OfferPinned`
  - `pub struct NewOffer { pub lender: XOnlyPublicKey, pub first_input: OutPoint, pub ephemeral_sk: SecretKey, pub secrets: OfferSecrets, pub signed_terms: SignedTerms, pub pinned: OfferPinned, pub marker: Marker }`
  - `NewOffer::build(borrower: &LendingKey, lender: &XOnlyPublicKey, first_input: &OutPoint, program_id: [u8; 4], collateral_asset: AssetId, collateral_amount: u64, terms: OfferTerms) -> Result<NewOffer, OfferError>` — the ephemeral key and the pad use the terms' NFT ids; the NFT issuance entropy must be fresh randomness for every build, and a retry rebroadcasts the byte-identical transaction
  - `NewOffer::collateral_blinding(&self, output_index: usize) -> PinnedBlinding` (pending collateral, `ephemeral_sk`, `extra_data = signed_terms.encode()`); the PSET output's `blinding_key` must be `lift_lending_key(&self.lender)`
  - `pub struct OpenedOffer { pub signed_terms: SignedTerms, pub lender: XOnlyPublicKey, pub collateral: TxOutSecrets, pub secrets: OfferSecrets, pub pinned: OfferPinned }`
  - opening as the lender or the borrower is crate-private (`open_as_lender(lender, &FoundOffer)`, `open_as_borrower(borrower, &FoundOffer)`); callers use Task 7's `open_creation_as_lender` / `open_creation_as_borrower`, which also run the creation checks
  - `pub enum OfferError { ZeroAmount, RepaymentBelowPrincipal, ExpirationNotBlockHeight }` (expiration ≥ 500 000 000), `pub enum OpenError { ViewTagMismatch, NotMine, Rewind(RewindError), Terms(TermsError), CollateralMismatch }`

- [ ] **Step 1: Write the failing tests** (blinding a real output via `blind_pset` from Task 4 inside a test helper `blinded_offer_output(&NewOffer) -> TxOut`):
  - `lender_opens_offer`: `open_as_lender` returns terms equal to the built ones, `collateral` equal to `(collateral_asset, collateral_amount)`, and `pinned` equal to `new.pinned`.
  - `borrower_recovers_offer`: `open_as_borrower` with the borrower's key returns the same `OpenedOffer` (including `lender`).
  - `other_borrower_cannot_recover`: another key → `Err(OpenError::NotMine)`.
  - `view_tag_collision_with_wrong_key_is_rejected`: loop lending keys `[i; 32]` until one's `view_tag` equals the marker's but it isn't the lender; `open_as_lender` → `Err(OpenError::Rewind(_))`.
  - `wrong_view_tag_is_rejected_before_rewinding`: `Err(OpenError::ViewTagMismatch)`.
  - `collateral_with_foreign_blinders_is_rejected`: blind the offer output with random blinders but the same terms → `Err(OpenError::CollateralMismatch)`.
  - `build_rejects_invalid_amounts`: principal 0 → `ZeroAmount`; repayment below principal → `RepaymentBelowPrincipal`; collateral 0 → `ZeroAmount`.
- [ ] **Step 2: Run** `cargo test -p private-lending-core offer` — Expected: FAIL.
- [ ] **Step 3: Implement.** `open_as_lender`: check `marker.view_tag` against `OfferSecrets::for_lender(..).view_tag()`, `rewind`, decode and verify the terms (lender = own key), derive `OfferPinned`, compare `pending_collateral.secrets()` with the rewound secrets. `open_as_borrower`: compare `offer.nonce` with `ephemeral_key(..)·G` (else `NotMine`), decrypt the lender key from the marker, then the same steps with `OfferSecrets::for_borrower`.
- [ ] **Step 4: Run** `cargo test -p private-lending-core` — Expected: all pass.
- [ ] **Step 5: Commit** — `git commit -m "private-lending-core: build and open offers"`

### Task 6: Contract v1 (program, parameters, witness) on derived secrets

**Files:**
- Modify: `crates/contracts/simf/private_lending.simf`, `crates/contracts/src/programs/private_lending/{params.rs,witness.rs,core.rs,mod.rs}`, `crates/contracts/tests/private_lending/*.rs`
- Generated: `crates/contracts/src/artifacts/` (`simplex build`)

**Interfaces:**
- Consumes: `OfferPinned`, `OfferTerms`, `NewOffer` (Task 5).
- Produces:
  - `pub struct PrivateLendingParameters { pub borrower_nft_asset_id: AssetId, pub lender_nft_asset_id: AssetId, pub pinned: OfferPinned, pub loan_expiration_time: u32, pub network: SimplicityNetwork }` (`PartialEq, Eq`) with `from_terms(terms: &OfferTerms, pinned: OfferPinned, network: SimplicityNetwork) -> PrivateLendingParameters` (NFTs and expiration from the terms; creation and verification both use it), `get_principal_output_asset_auth`, `get_repayment_output_asset_auth`, `build_arguments` (no fee getters or arguments)
  - `PrivateLendingWitnessBranch::{OfferAcceptance, OfferCancellation, PartialRepayment, FullRepayment, Liquidation}` mapping to `Left(Left(()))`, `Left(Right(()))`, `Right(Left(Left(())))`, `Right(Left(Right(())))`, `Right(Right(()))`
  - `PrivateLendingOffer` storage capacity 2: slot 0 `is_active`, slot 1 `pinned.repayment.commitment_hash()`
  - `attach_full_repayment(ctx, borrower_nft_utxo, active_offer_utxo, lender_blinding_key)` (no fee key)

- [ ] **Step 1: Update the tests first.** Setup builds a `NewOffer` from test lending keys (`LendingKey::from_master_blinding_key(&[1; 32])` borrower, `[2; 32]` lender, first input = the lender NFT coin's outpoint, which is input 0 of today's creation) and builds parameters from `new.pinned`; NFT issuance and creation stay as today for this task. Full repayment asserts a single pinned repayment output at index 1 equal to principal + interest (`10_000 + 1_000 = 11_000` with the default 10% rate) and no fee output. Add to `failure_flows.rs`:
  - `private_offer_partial_repayment_branch_fails`: spending the active offer with `PartialRepayment` is rejected by the program (`assert_program_rejects`).
  - `private_offer_repayment_fails_with_wrong_debt_slot`: fund the address of an active offer whose slot 1 holds another hash (`pinned.principal.commitment_hash()`) with the pinned active collateral, then attempt full repayment from it → rejected by the program.
- [ ] **Step 2: Run** `cd crates/contracts && simplex build && simplex test --target private_lending --no-fail-fast` — Expected: compile errors or failures.
- [ ] **Step 3: Change the program.** Remove `PROTOCOL_FEE_COMMITMENT`, `PROTOCOL_FEE_OUTPUT_SCRIPT_HASH` and the fee output check; add a debt slot leaf (`tapdata` of the 32-byte hash, mirroring `get_borrower_debt_slot_leaf` in `lending.simf`) and `get_script_hash_for_storage(is_active: bool, debt: u256)` combining both leaves as `lending.simf` does; every branch uses `param::REPAYMENT_COMMITMENT` as the debt; `main` matches `Either<Either<(),()>, Either<Either<(),()>, ()>>` with the partial branch `panic!()`. Update the header comment (no fee, debt slot, reserved branch).
- [ ] **Step 4: Update** `params.rs`, `witness.rs`, `core.rs` to the Interfaces above.
- [ ] **Step 5: Run** the Step 2 command — Expected: all private lending tests pass (8 adapted + 2 new).
- [ ] **Step 6: Commit** — clippy clean; `git commit -m "private lending: contract v1 without fee, with debt slot and reserved partial branch"`

### Task 7: Creation flow, lender verification, borrower recovery

**Files:**
- Modify: `crates/contracts/src/programs/private_lending/core.rs`, `crates/contracts/tests/private_lending/setup.rs`
- Create: `crates/contracts/src/programs/private_lending/verify.rs`, `crates/contracts/tests/private_lending/offer_creation_flows.rs`

**Interfaces:**
- Consumes: Tasks 5–6.
- Produces:
  - `PrivateLendingOffer::attach_creation(&self, ctx: &mut ConfidentialTransaction, new_offer: &NewOffer, borrower_nft_receiver: Script)` — outputs 0–3 in the creation layout; output 3 via `add_pinned_output_with(.., new_offer.ephemeral_sk, new_offer.signed_terms.encode())` blinded to `lift_lending_key(&new_offer.lender)`; panics unless input 0 is `new_offer.first_input` and the offer's parameters equal `PrivateLendingParameters::from_terms(&new_offer.signed_terms.terms, new_offer.pinned, network)`
  - `pub fn add_nft_issuances(ctx: &mut ConfidentialTransaction, borrower_coin: UTXO, lender_coin: UTXO) -> (AssetId, AssetId)` — inputs 0 and 1, returns (borrower NFT, lender NFT); fresh random issuance entropy on every call
  - private-lending-core (`src/creation.rs`), the checks without addresses, shared with the wasm module:
    - `pub struct FoundOffer { pub marker: Marker, pub offer: TxOut, pub offer_outpoint: OutPoint, pub first_input: OutPoint, pub borrower_nft: AssetId, pub lender_nft: AssetId }`
    - `pub fn find_offer(creation_tx: &Transaction, program_id: [u8; 4]) -> Option<FoundOffer>` — marker of `program_id` at output 2, offer at output 3, first input = input 0's outpoint, NFT ids = the explicit assets of outputs 0 and 1; for the indexer
    - `pub fn open_creation_as_lender(lender: &LendingKey, creation_tx: &Transaction, program_id: [u8; 4]) -> Result<OpenedOffer, CreationError>` and `pub fn open_creation_as_borrower(borrower: &LendingKey, creation_tx: &Transaction, program_id: [u8; 4]) -> Result<OpenedOffer, CreationError>` — find, open, then check principal ≥ 1, repayment ≥ principal, expiration < 500 000 000, a new issuance at input 1 of exactly one explicit unit of `terms.lender_nft` without reissuance token, and outputs 0 and 1 holding one explicit unit each of `terms.borrower_nft` and `terms.lender_nft`
    - `pub enum CreationError { NotFound, Open(OpenError), InvalidTerms, LenderNftNotUnique, NftOutputMismatch }`
  - contracts (`verify.rs`), the address checks:
    - `pub fn verify_offer_as_lender(lender: &LendingKey, creation_tx: &Transaction, network: SimplicityNetwork) -> Result<(OpenedOffer, PrivateLendingParameters), VerifyError>` and `pub fn verify_offer_as_borrower(borrower: &LendingKey, creation_tx: &Transaction, network: SimplicityNetwork) -> Result<(OpenedOffer, PrivateLendingParameters), VerifyError>` — the core entry point with `PrivateLendingOffer::get_program_id()`, parameters from `from_terms`, output 3 at `PrivateLendingOffer::new_pending(params).get_script_pubkey()` and output 1 at `ScriptAuth::from_simplex_program(&offer).get_script_pubkey()`; the borrower runs `verify_offer_as_borrower` on its finished creation transaction before broadcasting it
    - `pub enum VerifyError { Creation(CreationError), AddressMismatch, LenderNftNotLocked }`

- [ ] **Step 1: Write the failing tests** in `offer_creation_flows.rs`:
  - `lender_finds_opens_and_verifies_offer`: after creation, `find_private_offer(&creation_tx)` → `open_as_lender` → `verify_pending_offer` returns parameters whose `build_arguments()` equal the borrower's.
  - `borrower_recovers_offer_from_chain`: `open_as_borrower` with the borrower key returns the lender's x-only key and the same pinned outputs.
  - `dishonest_repayment_fails_verification` (no chain needed): build parameters whose `pinned.repayment` has amount `repayment_amount - 1`, compute that offer's script pubkey, and check `verify_pending_offer` on a txout with that script returns `Err(VerifyError::AddressMismatch)`.
  - Rewrite `setup_pending_private_offer` to create offers through `add_nft_issuances` + `attach_creation`; all other phase tests keep passing on top of it.
- [ ] **Step 2: Run** `cd crates/contracts && simplex test --target private_lending --no-fail-fast` — Expected: FAIL (missing functions).
- [ ] **Step 3: Implement** `add_nft_issuances` (simplex `add_issuance_input` with `IssuanceInput::new_issuance(1, 0, get_random_seed())`; the asset ids travel in the terms, so the entropy need not be reproducible), `attach_creation`, `find_private_offer`, `verify_pending_offer`.
- [ ] **Step 4: Run** the Step 2 command — Expected: every private lending test passes (phases, failures, creation flows).
- [ ] **Step 5: Run** `cd crates/contracts && simplex test --no-fail-fast` — Expected: the public contract tests are unaffected.
- [ ] **Step 6: Commit** — clippy clean; report the test counts; `git commit -m "private lending: creation flow, lender verification, borrower recovery"`
