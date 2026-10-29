# Private lending: session handoff (2026-10-29)

Read this file first, then the spec. It lists what exists, what comes next, and the decisions a new session cannot recover from the code.

- Spec (the binding design): `docs/superpowers/specs/2026-10-28-private-lending-design.md`
- Plan, part A (executed): `docs/superpowers/plans/2026-10-28-private-lending-core-and-contract.md`
- Plan, part B (executed): `docs/superpowers/plans/2026-10-29-private-lending-indexer.md`
- Plan, part C1 (executed): `docs/superpowers/plans/2026-10-29-private-lending-wasm.md`

## Where things stand

Part A is done. It was built on branch `private-lending-v1`, merged into `main`, and pushed to the `fork` remote (`juja256/simplicity-lending`). The `origin` remote is BlockstreamResearch's upstream repository. Nothing was pushed there.

Part B (the indexer) is done on branch `private-lending-indexer`. It is not merged and not pushed yet; the user decides. What it added:
- **Core:** `directory_message`, `sign_directory_action` and `verify_directory_action`, with known-answer vectors. The wasm module signs directory writes with these.
- **Detection:** `PrivateOffersTracker` (`crates/indexer/src/indexer/trackers/private_offers/`) finds candidates with `find_offer` plus a confidential nonce at output 3. It stores the light fields and the whole creation transaction.
- **States:** pending, active, cancelled, repaid and liquidated, classified by the NFT burned at output 0 of the spending transaction. Claims show as spent `principal` and `repayment` UTXOs. There is no `claimed` status. Colliding spends of fake candidates cannot halt the indexer: UTXO inserts use `ON CONFLICT DO NOTHING`.
- **API:**
  - Candidates: `GET /private/candidates?from_height&to_height&limit&offset`, `/private/candidates/{creation_txid}` and `.../tx`.
  - Directory: `POST /private/directory/challenges`, and `GET`, `PUT` and `DELETE` on `/private/directory/{pubkey}`, plus `GET /private/directory`.
  - The shapes, byte orders and the sync recipe are in `crates/indexer/README.md`.
- **Tests:** 51 core tests and 130 indexer tests pass. The indexer count includes 13 indexing, 5 candidates API and 8 directory tests.

**`crates/private-lending-core`** depends only on `elements` 0.25.2 and `rand`, so it compiles to wasm in part C. It contains:
- **Keys and secrets.** Lending keys derived from a wallet's SLIP-77 master blinding key. Per-offer secrets derived from the borrower–lender ECDH secret: view tag and blinders.
- **Terms.** 217 bytes, signed by the borrower (BIP340), and carried as extra data in the collateral output's range proof.
- **Marker.** 37 bytes, carried in an OP_RETURN: `program_id ‖ view_tag ‖ lender key encrypted to the borrower`.
- **Blinding.** `blind_pset` blinds pinned outputs. It also adds the blind value and asset proofs that LWK's Jade signer needs.
- **Soundness gate.** `find_offer`, `open_creation_as_lender` and `open_creation_as_borrower` run every check that needs no simplex.

**Contract v1** (`crates/contracts/simf/private_lending.simf`, Rust side in `crates/contracts/src/programs/private_lending/`) differs from the earlier draft:
- **No protocol fee.**
- **Two storage slots:** `is_active` and a debt commitment that equals `REPAYMENT_COMMITMENT` from creation on.
- **Reserved branch:** a partial-repayment branch that always fails (`panic!()`).
- **Creation:** the creation transaction issues both NFTs itself (inputs 0 and 1). Outputs: 0 borrower NFT, 1 lender NFT locked to the offer with script_auth, 2 marker, 3 pending offer.
- **Verification:** `verify_offer_as_lender` and `verify_offer_as_borrower` combine the core gate with the address checks. A borrower must self-verify the finished creation transaction before broadcasting it.

**Tests on the final tree:**
- 49 core tests and 20 private-lending regtest tests pass. The other contract targets also pass.
- Public lending passes 18/18 at `RUST_TEST_THREADS=4`. At default parallelism, one random test fails with simplex's confirmation timeout in `tests/common/wallet.rs`. That failure predates this work; the branch does not touch the code involved.

## What comes next, in order

1. **Part B** is merged into `main`. **Part C1**, the wasm module and browser addresses (plan `docs/superpowers/plans/2026-10-29-private-lending-wasm.md`), is done on the branch `private-lending-wasm`, waiting for the user's review.
   - `crates/private-lending-wasm` wraps the core for the browser. Its README is the API reference for C2: exports, formats, error codes, consumed handles, and blinding keys.
   - `pnpm parity` (in `web/`) runs the whole browser path, wasm + LWK, against a real regtest offer recorded in `web/scripts/fixtures/private-lending-parity.json`. It passes, which means:
     - LWK's simplicityhl 0.4.1 gives the same addresses as Rust's 0.5.0;
     - LWK and the wasm module agree on the blinder string format;
     - a tampered offer fails the address check.
   - The core's `blind_pset` now keeps each pinned output's `blinder_index` after blinding. rust-elements rejects a PSET output that has a blinding key but no blinder index, and every browser PSET passes through base64.
   - `deployment/Dockerfile.web` has a Rust stage that builds the wasm package. Docker could not run here, so the image must be built once before relying on it.
2. **Plan and build part C2: the flows and pages.** It builds on C1 and must carry these rules from parts A, B and C1:
   - **One verification gate.** A single TypeScript function is the only producer of "valid offer" objects:
     1. `openCreationAs*`;
     2. `loadPrivateOfferScripts(toPrivateOfferArguments(...))`;
     3. `verifyOfferAddresses`, on the same transaction.
     An offer that is opened but unchecked is never acceptable.
   - **The borrower's self-check treats every error code as fatal.** "Skip silently" applies only to the lender's inbox. Once `isOwnCandidate` is true, an open error means "own offer, unreadable", not "skip".
   - **Blinding keys.** Output 3 of the creation carries `NewOffer.collateralBlindingKey()`. Outputs created at acceptance carry `OpenedOffer.borrowerBlindingKey()`. A wrong key strands the collateral.
   - **Fresh NFT entropy.** Draw a random contract hash for every build, and get the NFT ids from `issuedAssetId`. Do not reuse `web/src/lwk/assetContract.ts`, which is deterministic per outpoint and gives an all-zero hash on localhost and regtest. A retry rebroadcasts the byte-identical transaction.
   - **Blinding and signing order.**
     1. Build the PSET with LWK `skipBlinding()`, with issuance inputs unblinded.
     2. Call `blindPset`. It consumes its handles, so make new ones for every call.
     3. Run `new Pset(b64)`, then extract the transaction and run the self-check.
     4. Sign, then finalize the Simplicity inputs with `buildPrivateLendingWitness`.
   - **Script pubkeys for accept and repay.** `PrivateOfferScripts` gives only the principal and repayment script hashes. Accept and repay also need the asset_auth script pubkeys.
   - **The wasm module loads lazily**, through `getPrivateLendingWasm`, and is 3 MB. Check that the production build emits and loads `private_lending_wasm_bg.wasm`: parity tests only the Node path.
   - **The indexer is untrusted.** It may hide candidates or substitute directory keys. Verify every offer in the browser and show key fingerprints (`LendingKey.fingerprint()` / `keyFingerprint`).
   - **Render directory names bidi-isolated, next to the key fingerprint.** The indexer rejects control characters but not format characters, such as bidi overrides and zero-width characters.
   - **Sync candidates by height.** The first page's `last_indexed_height` becomes `to_height` for the remaining pages, and the next sync starts at that height + 1. Txids and asset ids come as display-order hex. The indexer's `first_input` is `{txid, vout}`, and the wasm module takes `"txid:vout"`. Take nonces from the indexer, never from raw transaction bytes.
   - **Refresh on the existing `block_indexed` event.** There are no private-specific SSE events.
   - The UI shows the interest derived from the amounts (repayment − principal), never `interest_rate_bps` (Ruling P8).
   - Check on Jade hardware that pinned outputs with `blinder_index = Some(i)` sign. That is the only state a base64 PSET can carry; part A assumed `None`. LWK builds Jade's trusted commitments from the blind proofs.
   - Show the private section only for Jade and the seed wallet (see "Decisions" below).
   - **Deferred polish from C1's review:**
     - the near-identical error codes `terms-invalid` and `invalid-terms`;
     - core `blind_pset` does not refuse outputs that are already blinded;
     - no CI job runs `pnpm parity`;
     - the root README's crate list is stale.
3. **Scope the BP++ compiler change** in the bulletproofs repository (`~/juja_backup/projects/my/bulletproofs`). It can run in parallel with B and C, because no code is shared.
   - **What it is for.** Partial repayment needs the Simplicity verifier to take commitments from the transaction instead of baking them in as constants (`PointSrc::Const`). Its own docs list this as future work (`docs/simplicity-verifier.md`, "Bind the commitments V to the transaction's outputs").
   - **The value generator moves too.** For a confidential asset, Liquid commits `v·A + r·G`, where `A` is the output's blinded asset generator. So the value generator must also come from the transaction.
   - **Generators must match.** "Old debt = paid + new debt" holds only between commitments that share a generator. That needs either a verifier that supports several generators, or a shared asset blinder.

## Decisions the user made (not derivable from the code)

- **A separate contract.** The private contract is not merged into `lending.simf`. Full repayment only for now, with room left for partial repayment later.
- **Fully private.** The main case is an "institutional loan": all assets and amounts are hidden. Mixed privacy modes were skipped.
- **Offers are addressed to a lender's lending key.** The indexer serves a lender directory; a borrower can also paste a key directly.
- **Scanning happens in the browser.** The indexer never holds secret keys.
- **Recognizable creation transactions are fine.** The marker filters candidates.
- **The lending key comes from the master blinding key.** Accepted consequence: anyone holding the wallet's confidential descriptor can read that party's offers.
- **No fee keeper on private loans.** A fee tied to the interest would reveal the interest to whoever collects it.
- **Offers are signed by the borrower.** The lender sees who sent each offer.
- **No borrower account.** There is no issuance factory, so one borrower's private offers are not publicly linked.
- **The configured asset pair** (L-BTC collateral, USDT principal; TEST on testnet) for the PoC. The contract and the terms stay asset-agnostic.
- **Wallets: Jade plus the seed wallet.** Humid can't do private loans yet:
  - Its `signPset` refuses pre-blinded outputs, foreign confidential inputs and blinding scalars.
  - Its tx manifests force covenant outputs to be explicit and have no blinder fields.
  - It never exports blinders.
  - It could come later if its `signPset` learns to blind given outputs with caller-chosen blinders.

## Rulings made while executing part A

- **P1:** txids in internal byte order, vouts little-endian u32, secret keys as `secret_bytes()`.
- **P2:** the lender-key pad is a direct tagged hash over the borrower's key, not the shared secret.
- **P3:** `PrivateLendingOffer::new_with_storage` is public, for the wrong-debt-slot test.
- **P4:** asset ids in the terms use internal byte order.
- **P5:** opening also compares the offer output's actual commitments with the derived ones.
- **P6:** verification rejects a principal of 0 or a repayment below the principal.
- **P7:** verification takes the creation transaction. Input 1 must be a new issuance of the lender NFT with explicit amount 1 and no inflation keys. The expiry must be below 500 000 000.
- **P8:** `interest_rate_bps` is display-only.
- **F1:** the ephemeral key and the pad hash `borrower_sk ‖ txid ‖ vout ‖ borrower_nft ‖ lender_nft`. Without this, rebuilt creation transactions would reuse the range-proof nonce and leak the amounts.
- **F2:** the core entry points form the single soundness gate. Contracts adds only the address checks.
- **F3:** parameters come only from `PrivateLendingParameters::from_terms`. `NewOffer` records the lender and the first input, and `attach_creation` asserts both.
- **F4:** known-answer vectors pin the byte formats.

## Deferred minor findings from part A

All are test and doc polish:
- Error `Display` repeats the inner error.
- Untested branches: the `find_offer` `None` paths, the `NotMine` cases, and the wrong-first-input decrypt.
- The issuance check accepts `Explicit(0)` inflation keys. Consensus rejects those anyway.
- Chain-free contract tests run under `#[simplex::test]`.
- The plan's step text names pre-fix APIs. Its Interfaces blocks and the spec are current.
- `attach_creation`'s input-0 assert holds only at call time. Self-verification covers it.

## Working notes

- **Contract artifacts.** `cd crates/contracts && simplex build` regenerates `src/artifacts/`, which is git-ignored.
- **Contract tests.**
  - Private lending: `simplex test --target private_lending --no-fail-fast`.
  - Filter by name: `simplex test <name>`.
  - All contract tests: `simplex test --no-fail-fast`.
  - Rare harness flakes (electrs indexing timeouts, HTTP 503s during the initial funding) pass on rerun.
- **Core tests.** `cargo test -p private-lending-core`.
- **Lint.** `cargo clippy --workspace --all-targets --all-features -- -D warnings`.
- **Indexer tests.** They need Postgres; see `.github/workflows/tests.yml` and `crates/indexer/scripts/init_db.sh`.
  - Locally, the user starts Postgres in Docker, which needs sudo, and a git-ignored `crates/indexer/.env` points `DATABASE_URL` at it.
  - Build and test with `SQLX_OFFLINE=true`: `SQLX_OFFLINE=true cargo test -p lending-indexer`. With the `.env` present, the existing `query!` macros would otherwise check against the live database.
  - New SQL in part B uses runtime `sqlx::query*` only, so `.sqlx/` needs no regeneration.
  - The `/home` disk fills up with stale test executables in `target/debug/deps`. Prune old copies when space runs low.
- **Web and wasm.**
  - There is no global `pnpm`. Run `npx pnpm@10.33.0 <script>` from `web/`.
  - `build:wasm` builds the wasm package into the git-ignored `web/src/wasm/private-lending/`. It needs the `wasm32-unknown-unknown` target, `wasm-pack` 0.15 and clang/llvm, all installed here. Run it before `lint` and `build`.
  - `parity` must pass before C2 relies on browser addresses. To regenerate its fixture, run `WRITE_PARITY_FIXTURE=1 simplex test write_private_lending_parity_fixture` in `crates/contracts`.
  - `format:check` already fails on `web/pnpm-lock.yaml` on `main`. Check changed files with `npx prettier --check <files>`.
- **The user's workflow:**
  - plans executed subagent-driven, with one commit per task;
  - pushes go to the `fork` remote, never to `origin`;
  - the user decides about merging and pushing.
- **Models.** As of 2026-10-28, the LiteLLM proxy served only Opus. Sonnet and Fable returned "no healthy deployments", so every subagent ran on Opus.
- **Related work elsewhere.**
  - The user opened an upstream rust-elements PR from their fork (`~/juja_backup/projects/my/rust-elements`, commit 486420f). It adds `RangeProofMessage::with_extra_data` and `TxOut::unblind_with_message`.
  - That fork is on elements 0.27, while this repo is on 0.25 through simplex. That is why the core crate builds range proofs with secp256k1-zkp directly.
