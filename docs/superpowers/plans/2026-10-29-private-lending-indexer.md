# Private lending, part B: indexer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The indexer finds private offers by their marker, follows each one through its states, serves light candidates and whole creation transactions, and keeps a lender directory whose writes are signed by the lending key.

**Architecture:** A new tracker, `PrivateOffersTracker`, sits in the existing `TrackerRegistry` beside the public trackers. It detects creation transactions with `private_lending_core::find_offer` and follows the offer outpoints with a `WatchCache`, as `OffersTracker` does. Two new API modules serve the candidates and the directory. The directory's signed message is defined in `private-lending-core`, so the browser's wasm module (part C) signs exactly what the indexer verifies.

**Tech Stack:** Rust 2024, axum 0.8, sqlx 0.8 on PostgreSQL 14, utoipa 5, elements 0.25.2 (secp256k1-zkp for BIP340).

**Spec:** `docs/superpowers/specs/2026-10-28-private-lending-design.md` (sections "Indexer", "Marker", "Keys and secrets"). Part A's plan, `docs/superpowers/plans/2026-10-28-private-lending-core-and-contract.md`, defines the core APIs used here. Part C relies on this plan's Interfaces blocks and on the README's endpoint list.

## Global Constraints

- Work on the branch `private-lending-indexer`, created from `main`. Each task ends with exactly one commit (message given in its last step), ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.
- Indexer tests need PostgreSQL with `DATABASE_URL` set (CI: `postgres://app:secret@localhost:5432/lending-indexer`, created by `SKIP_DOCKER=true ./scripts/init_db.sh` in `crates/indexer`). Run them with `cargo test -p lending-indexer`.
- New SQL uses the runtime-checked `sqlx::query`, `sqlx::query_as::<_, T>` and `sqlx::query_scalar`, never the `query!` macros, so the workspace `.sqlx/` data stays unchanged and `SQLX_OFFLINE=true cargo check -p lending-indexer` still builds.
- The indexer never handles a secret key and never reads terms. It reads only public data: `find_offer`, the marker, the output 3 nonce. Test code may use keys.
- The program id is `PrivateLendingOffer::get_program_id()` (trait `lending_contracts::programs::program::SimplexProgram`).
- A transaction is a candidate if `find_offer(tx, program_id)` returns `Some` and output 3's nonce is `confidential::Nonce::Confidential(_)`.
- Byte orders:
  - The DB stores txids and asset ids in internal byte order, like the existing tables.
  - The API writes txids and asset ids as display-order hex, using `api::utils::format_hex`. `Txid::from_str` and `AssetId::from_str` parse that format.
  - Keys, the nonce, the encrypted lender key, challenges and signatures are plain hex of their serialization, without reversal.
- Statuses: `pending`, `active`, `cancelled`, `repaid`, `liquidated`.
- UTXO types: `pending_offer`, `active_offer`, `principal`, `repayment`.
- Transitions, read from the contract's layouts (`crates/contracts/src/programs/private_lending/core.rs`). T is the spending transaction.
  - `pending_offer` spent, and T's output 0 is `OP_RETURN` with explicit asset = lender NFT: **cancelled**.
  - `pending_offer` spent, any other T: **active**. New `active_offer` at (T, 0) and `principal` at (T, 1).
  - `active_offer` spent, and T's output 0 is `OP_RETURN` with explicit asset = borrower NFT: **repaid**. New `repayment` at (T, 1).
  - `active_offer` spent, any other T: **liquidated**.
  - `principal` or `repayment` spent: the UTXO is marked spent, and the status stays.
  - These states describe real offers only. For a fake candidate they are meaningless, and clients verify every offer anyway.
  - Debt is modelled as the spec's "room for partial repayment" asks. `active` means the debt is outstanding. Repayments are a list of `repayment` UTXOs: one in v1, more with a later contract version.
- Directory signature:
  - Message: `tagged_hash("simplicity-lending/directory/v1", action ‖ pubkey ‖ challenge ‖ display_name)`.
  - `action` is one byte: `1` put, `2` delete. `pubkey` is the 32-byte x-only lending key. `challenge` is 32 bytes. `display_name` is UTF-8 and empty for delete.
  - The signature is BIP340.
- Challenges: 32 random bytes. Each is single-use and expires 300 seconds after it is issued.
- Display names: 1 to 64 characters, no leading or trailing whitespace, no control characters (`char::is_control`).
- JSON timestamps are unix seconds (`i64`). JSON heights are numbers.
- Public offers keep their tables, trackers and endpoints unchanged. No new SSE events: clients refetch on `block_indexed`.
- Before finishing any task:
  - `cargo fmt --all` has been run.
  - `cargo clippy --workspace --all-targets --all-features -- -D warnings` is clean.
  - `crates/indexer/README.md` documents what the task added.

## Review Focus

- **Creation and acceptance in the same block.** The acceptance's spend must see the pending UTXO the same block inserted. Test: `offer_created_and_accepted_in_one_block_is_active` (Task 3).
- **A restart between two transitions.** The cache rebuilt from the DB must carry the NFT ids that classify the next spend. Test: `tracking_survives_restarts` (Task 3).
- **Look-alike transactions.** A marker of another program, an output 3 with no confidential nonce, or fewer than four outputs must be skipped without failing the block. Test: `transactions_without_a_private_offer_are_ignored` (Task 2).
- **Byte orders across the API.** A browser parses the display-order hex. It must then match the view tag as the lender, and the nonce and the lender key as the borrower. Test: `light_candidate_lets_both_parties_recognize_the_offer` (Task 4).
- **Reused directory signatures.** These must all fail with 401: a put signature used to delete, a signature over another name, a used challenge, and an expired challenge. A bad signature must not consume the challenge. Tests: `signature_for_another_action_or_name_is_rejected`, `replayed_challenge_is_rejected`, `expired_challenge_is_rejected`, `bad_signature_is_rejected_and_keeps_the_challenge` (Task 5).

---

### Task 1: Directory signatures in the core

**Files:**
- Create: `crates/private-lending-core/src/directory.rs`
- Modify: `crates/private-lending-core/src/lib.rs` (module and re-exports)

**Interfaces:**
- Produces (re-exported at the crate root):
  - `pub const DIRECTORY_TAG: &str = "simplicity-lending/directory/v1";`
  - `#[derive(Clone, Copy, Debug, PartialEq, Eq)] pub enum DirectoryAction { Put, Delete }` with `pub fn byte(self) -> u8` (`1`, `2`)
  - `pub fn directory_message(action: DirectoryAction, pubkey: &XOnlyPublicKey, challenge: &[u8; 32], display_name: &str) -> [u8; 32]`
  - `pub fn sign_directory_action(key: &LendingKey, action: DirectoryAction, challenge: &[u8; 32], display_name: &str) -> schnorr::Signature`. Random aux, as `SignedTerms::sign` does.
  - `pub fn verify_directory_action(pubkey: &XOnlyPublicKey, action: DirectoryAction, challenge: &[u8; 32], display_name: &str, signature: &schnorr::Signature) -> bool`

- [ ] **Step 1: Write the failing tests** in `directory.rs`:

```rust
const CHALLENGE: [u8; 32] = [0x5c; 32];

#[test]
fn signature_verifies_for_its_action_key_challenge_and_name() {
    let key = LendingKey::from_master_blinding_key(&[1; 32]);
    let pk = key.x_only_public_key();
    let sig = sign_directory_action(&key, DirectoryAction::Put, &CHALLENGE, "Acme Bank");
    assert!(verify_directory_action(&pk, DirectoryAction::Put, &CHALLENGE, "Acme Bank", &sig));
    assert!(!verify_directory_action(&pk, DirectoryAction::Delete, &CHALLENGE, "Acme Bank", &sig));
    assert!(!verify_directory_action(&pk, DirectoryAction::Put, &[0x5d; 32], "Acme Bank", &sig));
    assert!(!verify_directory_action(&pk, DirectoryAction::Put, &CHALLENGE, "Acme Bank ", &sig));
    let other = LendingKey::from_master_blinding_key(&[2; 32]).x_only_public_key();
    assert!(!verify_directory_action(&other, DirectoryAction::Put, &CHALLENGE, "Acme Bank", &sig));
}

/// Frozen like part A's vectors: a change of tag, action byte or field order fails.
#[test]
fn directory_message_known_answer() {
    let pk = LendingKey::from_master_blinding_key(&[1; 32]).x_only_public_key();
    assert_eq!(directory_message(DirectoryAction::Put, &pk, &CHALLENGE, "Acme Bank").to_hex(),
               "37c926ac9b518f3fe9e2c464b41d41ca4bda43475f7dd405d1af398a5764935c");
    assert_eq!(directory_message(DirectoryAction::Delete, &pk, &CHALLENGE, "").to_hex(),
               "53c1a6c4455d33851cdf9120d0af95c2e8b5eec23565693631780d8c6328cc27");
}
```

The frozen values were computed with Python's `hashlib`, independently of the Rust code, from the definition in Global Constraints. They use the x-only key `a9ddbd65…9762`, which `lending_key_known_answers` pins for `[1; 32]`.

- [ ] **Step 2: Run** `cargo test -p private-lending-core directory`. Expected: compile errors, because the items are missing.
- [ ] **Step 3: Implement** `directory.rs`, using `tagged_hash`, `Message::from_digest`, `SECP256K1.sign_schnorr_with_aux_rand` and `verify_schnorr`.
- [ ] **Step 4: Run** `cargo test -p private-lending-core`. Expected: all tests pass (49 earlier + 2).
- [ ] **Step 5: Commit.** `git add crates/private-lending-core && git commit -m "private-lending-core: signed lender directory actions"`

### Task 2: Detecting private offers

**Files:**
- Create:
  - `crates/indexer/migrations/20261029120000_private_offers.sql`
  - `crates/indexer/src/models/private_offer.rs`
  - `crates/indexer/src/indexer/trackers/private_offers/{mod.rs,core.rs,db.rs}`
  - `crates/indexer/tests/private_offers_indexing.rs`
- Modify:
  - `crates/indexer/Cargo.toml`: add `private-lending-core = { path = "../private-lending-core" }`.
  - `crates/indexer/src/models/mod.rs`
  - `crates/indexer/src/indexer/trackers/{mod.rs,registry.rs}`
  - `crates/indexer/src/indexer/block_processor.rs`
  - `crates/indexer/tests/common/mod.rs`
  - `crates/indexer/README.md`

**Interfaces:**
- Schema:

```sql
CREATE TYPE private_offer_status AS ENUM ('pending', 'active', 'cancelled', 'repaid', 'liquidated');
CREATE TYPE private_utxo_type AS ENUM ('pending_offer', 'active_offer', 'principal', 'repayment');

CREATE TABLE private_offers (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    creation_txid BYTEA NOT NULL UNIQUE,
    creation_tx BYTEA NOT NULL,              -- consensus-encoded, served whole
    nonce BYTEA NOT NULL,                    -- output 3's nonce, 33-byte compressed key
    view_tag SMALLINT NOT NULL,
    encrypted_lender_key BYTEA NOT NULL,
    first_input_txid BYTEA NOT NULL,
    first_input_vout BIGINT NOT NULL,
    borrower_nft_asset_id BYTEA NOT NULL,
    lender_nft_asset_id BYTEA NOT NULL,
    current_status private_offer_status NOT NULL DEFAULT 'pending',
    created_at_height BIGINT NOT NULL,
    updated_at_height BIGINT NOT NULL
);
CREATE INDEX idx_private_offers_created ON private_offers (created_at_height, id);

CREATE TABLE private_offer_utxos (   -- columns as offer_utxos, with utxo_type private_utxo_type
    offer_id BIGINT NOT NULL REFERENCES private_offers(id) ON DELETE CASCADE,
    utxo_type private_utxo_type NOT NULL,
    txid BYTEA NOT NULL, vout INTEGER NOT NULL, created_at_height BIGINT NOT NULL,
    spent_txid BYTEA, spent_at_height BIGINT,
    PRIMARY KEY (txid, vout)
);
```

- `models/private_offer.rs`:
  - `PrivateOfferStatus` and `PrivateUtxoType` derive `sqlx::Type` with `type_name` set to the enums above, plus `Serialize`, `Deserialize` and `utoipa::ToSchema`, all in lowercase snake case. Copy the attributes from `OfferStatus` and `UtxoType`.
  - `#[derive(Debug, Clone, sqlx::FromRow)] pub struct PrivateOfferModel`: every `private_offers` column except `creation_tx`, using the Rust types of `OfferModel`: `Vec<u8>` for bytes, `i16` for `view_tag`, `i64` for heights and `first_input_vout`.
  - `#[derive(Debug, Clone, sqlx::FromRow)] pub struct PrivateOfferUtxoModel`: the fields of `OfferUtxoModel`, with `utxo_type: PrivateUtxoType`.
- `trackers/private_offers`:
  - `pub struct PrivateOfferWatchEntry { pub offer_id: i64, pub utxo_type: PrivateUtxoType, pub borrower_nft: AssetId, pub lender_nft: AssetId }`
  - `pub struct PrivateOffersTracker` with:
    - `load(db_pool: &PgPool) -> anyhow::Result<Self>`. The cache holds every unspent `private_offer_utxos` row, joined with its offer for the NFT ids.
    - `begin_block`, `commit_block`, `abort_block`
    - `process_tx(&mut self, sql_tx: &mut DbTx<'_>, tx: &Transaction, block_height: u64) -> anyhow::Result<()>`
  - `db.rs`:
    - `pub async fn insert_private_offer(sql_tx, offer: &PrivateOfferModel, creation_tx: &[u8]) -> Result<Option<i64>, sqlx::Error>`, with `ON CONFLICT (creation_txid) DO NOTHING RETURNING id`
    - `pub async fn insert_private_offer_utxo(sql_tx, utxo: &PrivateOfferUtxoModel) -> Result<(), sqlx::Error>`
- `BlockProcessor::index_block(&mut self, block_height: u64, block_hash: String, txs: &[Transaction]) -> anyhow::Result<()>`: today's SQL-transaction half of `process_block`, made public. `process_block` fetches the block, then calls it. Tests drive the real pipeline through it.
- `TrackerRegistry`:
  - It gains `private_offers: PrivateOffersTracker`, loaded in `load`.
  - It forwards `begin_block`, `commit_block` and `abort_block`.
  - Its `process_tx` calls `private_offers.process_tx` for every transaction, after the public trackers.
- `tests/common/mod.rs`:
  - `test_pool` also truncates `private_offer_utxos` and `private_offers`.
  - `pub fn private_program_id() -> [u8; 4]`
  - `pub fn lending_key(byte: u8) -> LendingKey`: `from_master_blinding_key(&[byte; 32])`
  - `pub struct PrivateCreation { pub tx: Transaction, pub offer: NewOffer }`
  - `pub fn private_creation(borrower: &LendingKey, lender: &LendingKey, first_input: OutPoint) -> PrivateCreation`
    - It builds the offer with `NewOffer::build`. The NFT ids derive from `first_input`, so different offers get different ids.
    - Input 0 spends `first_input`, and input 1 any other outpoint.
    - Outputs 0 and 1 hold one explicit unit of the borrower and lender NFTs, at a non-`OP_RETURN` script.
    - Output 2 is `Script::new_op_return(&offer.marker.encode())`.
    - Output 3 is an explicit collateral with `nonce: Nonce::Confidential(e·G)`, where `e = offer.ephemeral_sk`.
    - The transaction stays unblinded and unsigned. The indexer reads only the layout, the marker and the nonce.
  - `pub async fn block_processor(pool: &PgPool) -> anyhow::Result<BlockProcessor>`. Use `TrackerRegistry::load(pool, AssetId::from_slice(&[5; 32])?, SimplicityNetwork::LiquidTestnet, None)` and `EsploraClient::new()`, which is never called.
  - `pub async fn index_block(processor: &mut BlockProcessor, height: u64, txs: &[Transaction]) -> anyhow::Result<()>`
  - `pub async fn private_offer_row(pool: &PgPool, creation_txid: Txid) -> anyhow::Result<Option<PrivateOfferModel>>`
  - `pub async fn private_utxo_rows(pool: &PgPool, offer_id: i64) -> anyhow::Result<Vec<PrivateOfferUtxoModel>>`, ordered by `created_at_height, vout`
  - `pub async fn private_offer_count(pool: &PgPool) -> anyhow::Result<i64>`

- [ ] **Step 1: Write the failing tests** in `tests/private_offers_indexing.rs` (`#[tokio::test] #[serial]`, as in `api_integration.rs`):

```rust
#[tokio::test]
#[serial]
async fn private_offer_creation_is_indexed() -> anyhow::Result<()> {
    let pool = test_pool().await?;
    let mut processor = block_processor(&pool).await?;
    let creation = private_creation(&lending_key(1), &lending_key(2), outpoint_with_txid_byte(0x31, 7));
    index_block(&mut processor, 100, &[creation.tx.clone()]).await?;

    let found = find_offer(&creation.tx, private_program_id()).unwrap();
    let row = private_offer_row(&pool, creation.tx.txid()).await?.expect("indexed");
    let nonce = PublicKey::from_secret_key(SECP256K1, &creation.offer.ephemeral_sk);
    assert_eq!(row.nonce, nonce.serialize().to_vec());
    assert_eq!(row.view_tag, i16::from(found.marker.view_tag));
    assert_eq!(row.encrypted_lender_key, found.marker.encrypted_lender_key.to_vec());
    assert_eq!(row.first_input_txid, found.first_input.txid.to_byte_array().to_vec());
    assert_eq!(row.first_input_vout, 7);
    assert_eq!(row.borrower_nft_asset_id, found.borrower_nft.into_inner().0.to_vec());
    assert_eq!(row.lender_nft_asset_id, found.lender_nft.into_inner().0.to_vec());
    assert_eq!((row.current_status, row.created_at_height, row.updated_at_height),
               (PrivateOfferStatus::Pending, 100, 100));

    let utxos = private_utxo_rows(&pool, row.id).await?;
    assert_eq!(utxos.len(), 1);
    assert_eq!((utxos[0].utxo_type, utxos[0].txid.clone(), utxos[0].vout, utxos[0].spent_txid.clone()),
               (PrivateUtxoType::PendingOffer, creation.tx.txid().to_byte_array().to_vec(), 3, None));
    Ok(())
}
```

Two more tests:
- `reindexing_a_creation_does_not_duplicate_it`: index the same creation in blocks 100 and 101 with the same processor. Both calls return `Ok`. `private_offer_count` is 1, and `created_at_height` is 100.
- `transactions_without_a_private_offer_are_ignored`: one block holds four variants of a valid creation, and `index_block` returns `Ok` with `private_offer_count` 0. The variants:
  - output 2 re-encoded with `program_id = [0; 4]`;
  - output 3's nonce set to `Nonce::Null`;
  - outputs truncated to three;
  - `tx_with_input(outpoint_with_txid_byte(0x77, 0), vec![normal_output()])`.

- [ ] **Step 2: Run** `cargo test -p lending-indexer --test private_offers_indexing`. Expected: compile errors.
- [ ] **Step 3: Write the migration and the models.**
- [ ] **Step 4: Implement the tracker's creation path.** `process_tx` calls `find_offer` and checks the nonce. It then inserts the offer, including `serialize(tx)`. If the insert returned an id, it inserts the `pending_offer` UTXO at (txid, 3) and caches it. It logs with `tracing::info!` as `OffersTracker` does.
- [ ] **Step 5: Wire the tracker** into `TrackerRegistry`. Split `BlockProcessor::index_block` out of `process_block`. Add the helpers to `tests/common`.
- [ ] **Step 6: Run** `cargo test -p lending-indexer`. Expected: the 3 new tests and all existing tests pass.
- [ ] **Step 7: Document.** In the README's indexing pipeline section, add how private offers are detected: the marker of this program at output 2, a confidential nonce at output 3, and the stored fields.
- [ ] **Step 8: Commit.** Clippy clean; `SQLX_OFFLINE=true cargo check -p lending-indexer` passes. `git commit -m "indexer: detect private offers by their marker"`

### Task 3: Following private offers through their states

**Files:**
- Modify:
  - `crates/indexer/src/indexer/trackers/private_offers/{core.rs,db.rs}`
  - `crates/indexer/tests/common/mod.rs`
  - `crates/indexer/tests/private_offers_indexing.rs`
  - `crates/indexer/README.md`

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - `core.rs`, crate-private and unit-tested:
    - `enum PendingSpend { Cancellation, Acceptance }` and `fn classify_pending_spend(tx: &Transaction, lender_nft: AssetId) -> PendingSpend`
    - `enum ActiveSpend { Repayment, Liquidation }` and `fn classify_active_spend(tx: &Transaction, borrower_nft: AssetId) -> ActiveSpend`
    - Both follow the transition rules in Global Constraints.
  - `db.rs`:
    - `pub async fn spend_private_offer_utxo(sql_tx, outpoint: &OutPoint, block_height: u64, txid: Txid) -> Result<(), sqlx::Error>`
    - `pub async fn update_private_offer_status(sql_tx, offer_id: i64, status: PrivateOfferStatus, block_height: u64) -> Result<(), sqlx::Error>`. It also sets `updated_at_height`.
  - `tests/common/mod.rs`, where each builder follows the contract's layout for its branch:
    - `pub fn burn_output(asset: AssetId) -> TxOut`: `OP_RETURN "burn"`, explicit asset, value 1.
    - `pub fn explicit_output(asset: AssetId, amount: u64) -> TxOut`: at `non_op_return_script()`.
    - `pub fn acceptance_tx(c: &PrivateCreation) -> Transaction`
      - Inputs: (c, 3) and (c, 1).
      - Outputs: active offer, principal, lender NFT.
    - `pub fn cancellation_tx(c: &PrivateCreation) -> Transaction`
      - Inputs: (c, 3), (c, 1) and the borrower NFT coin (c, 0).
      - Outputs: burn of the lender NFT, burn of the borrower NFT, collateral.
    - `pub fn repayment_tx(c: &PrivateCreation, active: OutPoint) -> Transaction`
      - Inputs: (c, 0) and `active`.
      - Outputs: burn of the borrower NFT, repayment, collateral.
    - `pub fn liquidation_tx(c: &PrivateCreation, active: OutPoint) -> Transaction`
      - Inputs: `active` and any lender NFT coin.
      - Outputs: burn of the lender NFT, collateral.
    - `pub fn claim_tx(spent: OutPoint) -> Transaction`

- [ ] **Step 1: Write the failing unit tests** in `core.rs`:
  - `pending_spend_burning_the_lender_nft_is_a_cancellation`
  - `other_pending_spends_are_acceptances`: output 0 not `OP_RETURN`, and output 0 burning the borrower NFT.
  - `active_spend_burning_the_borrower_nft_is_a_repayment`
  - `other_active_spends_are_liquidations`: output 0 burning the lender NFT, and output 0 not `OP_RETURN`.
- [ ] **Step 2: Write the failing integration tests** in `private_offers_indexing.rs`. Each indexes the creation at height 100, and each later transaction one height higher. "Spent by X at h" means `spent_txid == X.txid()` and `spent_at_height == h`.
  - `accepted_offer_becomes_active`
    - Status is `Active` with `updated_at_height` 101.
    - UTXOs, in order: `pending_offer` (c, 3) spent by the acceptance at 101; `active_offer` (A, 0) unspent; `principal` (A, 1) unspent.
  - `cancelled_offer_is_cancelled`
    - Status is `Cancelled`.
    - The only UTXO is `pending_offer`, spent by the cancellation.
  - `repaid_offer_and_both_claims`
    - Status is `Repaid` after the repayment at 102.
    - `repayment` (R, 1) is unspent.
    - `claim_tx(principal)` and `claim_tx(repayment)` run at 103. Both UTXOs are then spent at 103, and the status is still `Repaid` with `updated_at_height` 102.
  - `liquidated_offer_is_liquidated`
    - Status is `Liquidated`.
    - `active_offer` is spent, and no `repayment` exists.
  - `offer_created_and_accepted_in_one_block_is_active`
    - One `index_block` call holds `[creation, acceptance]`, and the status is `Active`.
  - `tracking_survives_restarts`
    - The creation is indexed with one processor. The acceptance is indexed with a fresh `block_processor(&pool)`, and the repayment with a third.
    - The status is `Repaid`.
- [ ] **Step 3: Run** `cargo test -p lending-indexer private`. Expected: FAIL.
- [ ] **Step 4: Implement** the spend path in `process_tx`, before the creation path. For each input whose outpoint is in the cache, apply its transition from Global Constraints. Write the UTXO and status rows, update the cache, and log one `tracing::info!` per transition.
- [ ] **Step 5: Run** `cargo test -p lending-indexer`. Expected: all tests pass.
- [ ] **Step 6: Document** the private states and transitions in the README. State that statuses mean something only for offers that verify.
- [ ] **Step 7: Commit.** Clippy clean. `git commit -m "indexer: follow private offers through their states"`

### Task 4: Candidates API

**Files:**
- Create:
  - `crates/indexer/src/api/private_offers/{mod.rs,routes.rs,handlers.rs,dto.rs,db.rs}`
  - `crates/indexer/tests/private_offers_api.rs`
- Modify:
  - `crates/indexer/src/api/{mod.rs,server.rs}`
  - `crates/indexer/src/api/openapi/doc.rs`: paths, schemas, the tag `private`, and the endpoints test.
  - `crates/indexer/README.md`

**Interfaces:**
- Consumes: Tasks 2–3 (tables, models, test helpers).
- Produces the endpoints, all `200` on success:
  - `GET /private/candidates?from_height&to_height&limit&offset` → `PrivateCandidateList`
    - `from_height` defaults to 0. `limit` defaults to 100, max 500. `offset` defaults to 0.
    - Read `last_indexed_height` from `sync_state` first. Return the candidates with `from_height ≤ created_at_height ≤ min(to_height, last_indexed_height)`, ordered by `(created_at_height, id)`.
    - A client pages with the `to_height` of its first page and next syncs from `last_indexed_height + 1`. With no sync state, the response is `items: []` and `last_indexed_height: null`.
    - A malformed parameter or a `limit` above 500 returns 400.
  - `GET /private/candidates/{creation_txid}` → `PrivateCandidateDetails`. Returns 404 if the candidate is unknown and 400 if the txid is malformed.
  - `GET /private/candidates/{creation_txid}/tx` → `PrivateCreationTx`. Same errors.
- DTOs in `dto.rs`, all `Serialize` and `ToSchema`:

```rust
pub struct OutPointDto { pub txid: String, pub vout: u32 }
pub struct PrivateCandidate {
    pub creation_txid: String,          // the offer is output 3 of this transaction
    pub nonce: String,                  // 33-byte compressed key, hex
    pub view_tag: u8,
    pub encrypted_lender_key: String,   // 32 bytes, hex
    pub first_input: OutPointDto,
    pub borrower_nft_asset_id: String,
    pub lender_nft_asset_id: String,
    pub status: PrivateOfferStatus,
    pub created_at_height: u64,
    pub updated_at_height: u64,
}
pub struct PrivateCandidateList { pub items: Vec<PrivateCandidate>, pub total: u64, pub limit: u64, pub offset: u64, pub last_indexed_height: Option<u64> }
pub struct PrivateUtxoDto { pub utxo_type: PrivateUtxoType, pub txid: String, pub vout: u32, pub created_at_height: u64, pub spent_txid: Option<String>, pub spent_at_height: Option<u64> }
pub struct PrivateCandidateDetails { #[serde(flatten)] pub candidate: PrivateCandidate, pub utxos: Vec<PrivateUtxoDto> }  // utxos by created_at_height, vout
pub struct PrivateCreationTx { pub tx_hex: String }
```

`spent_txid` and `spent_at_height` are always present, as `null` while the UTXO is unspent.

- [ ] **Step 1: Write the failing tests** in `tests/private_offers_api.rs`. Reuse `start_api`, `get_json` and `response_json` (move them from `api_integration.rs` into `tests/common` if they are not there yet).

```rust
#[tokio::test]
#[serial]
async fn light_candidate_lets_both_parties_recognize_the_offer() -> anyhow::Result<()> {
    let (borrower, lender) = (lending_key(1), lending_key(2));
    // index private_creation(&borrower, &lender, outpoint_with_txid_byte(0x31, 7)) at 100, start the API
    let item = &get_json(&http, format!("{base}/private/candidates")).await?["items"][0];
    let nonce = PublicKey::from_str(item["nonce"].as_str().unwrap())?;
    let view_tag = item["view_tag"].as_u64().unwrap() as u8;
    assert_eq!(OfferSecrets::for_lender(&lender, &nonce).view_tag(), view_tag);

    let first_input = OutPoint::new(Txid::from_str(item["first_input"]["txid"].as_str().unwrap())?,
                                    item["first_input"]["vout"].as_u64().unwrap() as u32);
    let borrower_nft = AssetId::from_str(item["borrower_nft_asset_id"].as_str().unwrap())?;
    let lender_nft = AssetId::from_str(item["lender_nft_asset_id"].as_str().unwrap())?;
    let e = ephemeral_key(&borrower, &first_input, borrower_nft, lender_nft);
    assert_eq!(PublicKey::from_secret_key(SECP256K1, &e), nonce);

    let marker = Marker { program_id: private_program_id(), view_tag,
        encrypted_lender_key: hex::decode(item["encrypted_lender_key"].as_str().unwrap())?.try_into().unwrap() };
    assert_eq!(marker.decrypt_lender_key(&borrower, &first_input, borrower_nft, lender_nft),
               Some(lender.x_only_public_key()));
    assert_eq!(item["creation_txid"], creation.tx.txid().to_string());
    assert_eq!(item["status"], "pending");
    Ok(())
}
```

Four more tests:
- `candidates_are_listed_by_height_range`
  - Before anything is indexed: `items` is `[]` and `last_indexed_height` is `null`.
  - Index one creation in each of blocks 100, 101 and 102.
  - `from_height=101`: candidates of 101 and 102, in that order. `total` is 2 and `last_indexed_height` is 102.
  - `from_height=101&to_height=101`: only the candidate of 101.
  - `limit=1&offset=1`: the candidate of 101, with `total` 3.
  - `limit=501` and `from_height=abc` both return 400.
- `candidate_details_include_its_utxos`
  - Create at 100, accept at 101, repay at 102.
  - `status` is `"repaid"` and `updated_at_height` is 102.
  - The `utxo_type`s, in order: `pending_offer`, `active_offer`, `principal`, `repayment`.
  - The pending UTXO's `spent_txid` is the acceptance's `txid().to_string()`, and its `spent_at_height` is 101.
  - The repayment's `spent_txid` is `null`.
- `creation_transaction_is_served_whole`: `deserialize::<Transaction>(&hex::decode(tx_hex)?)?` equals `creation.tx`.
- `unknown_and_malformed_txids_are_rejected`: both endpoints return 404 for an unknown 64-hex txid and 400 for `zz`.

- [ ] **Step 2: Run** `cargo test -p lending-indexer --test private_offers_api`. Expected: FAIL.
- [ ] **Step 3: Implement the module** after the pattern of `api/offers`. Pagination follows `OfferFilters::effective_limit` and `effective_offset`. Malformed query values return 400, through `deserialize_optional_u64`, made `pub(crate)`. Add the paths and schemas to `ApiDoc`. Add the three paths to `openapi_spec_contains_all_endpoints`.
- [ ] **Step 4: Run** `cargo test -p lending-indexer`. Expected: all tests pass.
- [ ] **Step 5: Document** the three endpoints, their fields and byte orders, and the sync recipe in a "Private lending" section of the README's API reference.
- [ ] **Step 6: Commit.** Clippy clean. `git commit -m "indexer: private offer candidates API"`

### Task 5: Lender directory

**Files:**
- Create:
  - `crates/indexer/migrations/20261029120100_lender_directory.sql`
  - `crates/indexer/src/api/directory/{mod.rs,routes.rs,handlers.rs,dto.rs,db.rs}`
  - `crates/indexer/tests/directory_api.rs`
- Modify:
  - `crates/indexer/Cargo.toml`: add `rand = "0.8"`.
  - `crates/indexer/src/api/{mod.rs,server.rs,error.rs}`
  - `crates/indexer/src/api/openapi/doc.rs`: tag `directory`.
  - `crates/indexer/tests/common/mod.rs`
  - `crates/indexer/README.md`

**Interfaces:**
- Consumes: Task 1 (`DirectoryAction`, `verify_directory_action`; tests use `sign_directory_action`).
- Schema:

```sql
CREATE TABLE directory_entries (
    pubkey BYTEA PRIMARY KEY,                 -- x-only lending key
    display_name TEXT NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE directory_challenges (
    challenge BYTEA PRIMARY KEY,
    expires_at timestamptz NOT NULL
);
```

- `ApiError::Unauthorized(String)` → 401, code `"unauthorized"`, with the message passed through unchanged.
- Endpoints:
  - `POST /private/directory/challenges` → 200 `DirectoryChallenge`
    - It first deletes the expired challenges, then inserts 32 random bytes expiring in 300 s.
  - `GET /private/directory?limit&offset` → 200 `DirectoryList`
    - Ordered by `display_name, pubkey`. `limit` defaults to 50, max 100.
  - `GET /private/directory/{pubkey}` → 200 `DirectoryEntry`, or 404.
  - `PUT /private/directory/{pubkey}`, body `PutDirectoryEntry` → 200 `DirectoryEntry`
    - Creates the entry, or updates it: the name and `updated_at` change, and `created_at` stays.
  - `DELETE /private/directory/{pubkey}`, body `DeleteDirectoryEntry` → 204, or 404 if there is no entry.
- Writes run their checks in this order:
  1. Parse the pubkey with `XOnlyPublicKey::from_slice`, and the 32-byte challenge and 64-byte signature hex. Validate the display name. A failure returns 400.
  2. `verify_directory_action`. A failure returns 401 with `"invalid signature"`.
  3. In one SQL transaction, consume the challenge with `DELETE … WHERE challenge = $1 AND expires_at > now() RETURNING challenge`. If no row comes back, return 401 with `"unknown, used or expired challenge"`. Then write the entry and commit. A delete that finds no entry rolls back and returns 404.
- DTOs, `Serialize`/`Deserialize` and `ToSchema` as needed:

```rust
pub struct DirectoryChallenge { pub challenge: String, pub expires_at: i64 }
pub struct DirectoryEntry { pub pubkey: String, pub display_name: String, pub created_at: i64, pub updated_at: i64 }
pub struct DirectoryList { pub items: Vec<DirectoryEntry>, pub total: u64, pub limit: u64, pub offset: u64 }
pub struct PutDirectoryEntry { pub display_name: String, pub challenge: String, pub signature: String }
pub struct DeleteDirectoryEntry { pub challenge: String, pub signature: String }
```

- `tests/common/mod.rs`:
  - `test_pool` also truncates `directory_entries` and `directory_challenges`.
  - `pub async fn seed_directory_challenge(pool: &PgPool, challenge: [u8; 32], expires_in_secs: i64) -> anyhow::Result<()>`. A negative value gives a challenge that has already expired.

- [ ] **Step 1: Write the failing tests.**
  - In `error.rs`: `unauthorized_maps_to_401`.
  - In `tests/directory_api.rs`, with helpers `issue_challenge(..) -> [u8; 32]` and `send_json(http, method, url, body) -> Response`. The helper sets `content-type: application/json`, because reqwest has no `json` feature here.
  - `directory_entry_round_trip`, with `key = lending_key(5)`:
    - Put "Acme Bank": 200, and the body's `display_name` is "Acme Bank".
    - The list holds exactly that entry, with `pubkey == key.x_only_public_key().to_string()`. `GET /private/directory/{pk}` returns the same entry.
    - Put "Acme Bank Ltd" with a new challenge: 200. `created_at` is unchanged, and `updated_at ≥ created_at`.
    - Delete with a new challenge, signing `sign_directory_action(&key, Delete, &c, "")`: 204. Then `GET` returns 404.
    - The challenge response's `expires_at − now` is in (290, 300].
  - `bad_signature_is_rejected_and_keeps_the_challenge`
    - Sign with `lending_key(6)`: 401 with `"invalid signature"`.
    - The same challenge with the right signature then returns 200.
  - `replayed_challenge_is_rejected`: the same put sent twice returns 200, then 401 with `"unknown, used or expired challenge"`.
  - `expired_challenge_is_rejected`: `seed_directory_challenge(.., -60)`, then a correctly signed put returns 401 with the challenge message.
  - `signature_for_another_action_or_name_is_rejected`: each case returns 401 with `"invalid signature"`.
    - A put signature over "Acme" used to delete.
    - A put signature over "Acme" sent with `display_name` "Acne".
  - `malformed_requests_are_rejected`: each returns 400.
    - Pubkey `zz`, and pubkey `ff` × 32, which is not on the curve.
    - A 31-byte challenge, and a 63-byte signature.
    - Display names `""`, `" Acme"`, 65 × `"a"` and `"Ac\u{7}me"`.
  - `deleting_a_missing_entry_is_not_found`: a correctly signed delete for a key with no entry returns 404.
- [ ] **Step 2: Run** `cargo test -p lending-indexer --test directory_api`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration, `ApiError::Unauthorized`, and the module after the pattern of `api/offers`.
  - Timestamps are read as `EXTRACT(EPOCH FROM …)::BIGINT`.
  - Challenges come from `rand::random::<[u8; 32]>()`.
  - Add the paths and schemas to `ApiDoc`, and the paths `/private/directory`, `/private/directory/{pubkey}` and `/private/directory/challenges` to the endpoints test.
- [ ] **Step 4: Run** `cargo test -p lending-indexer` and `cargo test -p private-lending-core`. Expected: all tests pass.
- [ ] **Step 5: Document** the directory endpoints in the README: the signed message, the action bytes, the challenge lifetime and the name rules. State that an entry proves control of the key, not identity.
- [ ] **Step 6: Commit.** Clippy clean; `SQLX_OFFLINE=true cargo check -p lending-indexer` passes. `git commit -m "indexer: lender directory with signed writes"`
