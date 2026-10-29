# Private lending: session handoff (2026-10-29)

Read this file first, then the spec. It lists what exists, what comes next, and the decisions a new session cannot recover from the code.

- Spec (the binding design): `docs/superpowers/specs/2026-10-28-private-lending-design.md`
- Plan, part A (executed): `docs/superpowers/plans/2026-10-28-private-lending-core-and-contract.md`

## Where things stand

Part A is done. It was built on branch `private-lending-v1`, merged into `main`, and pushed to the `fork` remote (`juja256/simplicity-lending`). The `origin` remote is BlockstreamResearch's upstream repository. Nothing was pushed there.

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

1. **Plan part B: the indexer.** Use superpowers:writing-plans with the spec, as for part A, then execute it subagent-driven.
   - It extends the existing axum + Postgres indexer (`crates/indexer`).
   - **Candidates.** Detect private offers with the core's `find_offer` (marker at output 2 with this program's id, from `PrivateLendingOffer::get_program_id()`). Store the offer outpoint, the nonce public key, the view tag, the encrypted lender key, the first input, the NFT ids and the height.
   - **States.** Track pending, active, cancelled, repaid and liquidated from NFT movements.
   - **API.** Serve light candidates, plus the full creation transaction on request. Verification needs the whole transaction (Ruling P7).
   - **Lender directory.** Writes require a BIP340 signature over `tagged_hash("simplicity-lending/directory/v1", action ‖ pubkey ‖ challenge ‖ display_name)`, using single-use, expiring challenges.
2. **Plan part C: the wasm module and front end.** It builds on the core crate and must carry these rules from part A:
   - The borrower self-verifies the creation transaction before broadcast.
   - NFT issuance entropy is fresh for every build. A retry rebroadcasts the byte-identical transaction.
   - The UI shows the interest derived from the amounts (repayment − principal), never `interest_rate_bps` (Ruling P8).
   - `getrandom` needs the `js` feature on wasm32.
   - Outputs created at acceptance are blinded to `lift_lending_key(borrower)`, because the lender does not know the borrower's wallet blinding key.
   - Check on Jade hardware that pinned outputs with `blinder_index = None` sign. LWK builds Jade's trusted commitments from the blind proofs.
   - Test that simplicityhl 0.5.0 (Rust) and the web app's LWK simplicityhl 0.4.1 compute the same contract address. That test gates the front-end work.
   - Show the private section only for Jade and the seed wallet (see "Decisions" below).
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
- **The user's workflow:**
  - plans executed subagent-driven, with one commit per task;
  - pushes go to the `fork` remote, never to `origin`;
  - the user decides about merging and pushing.
- **Models.** As of 2026-10-28, the LiteLLM proxy served only Opus. Sonnet and Fable returned "no healthy deployments", so every subagent ran on Opus.
- **Related work elsewhere.**
  - The user opened an upstream rust-elements PR from their fork (`~/juja_backup/projects/my/rust-elements`, commit 486420f). It adds `RangeProofMessage::with_extra_data` and `TxOut::unblind_with_message`.
  - That fork is on elements 0.27, while this repo is on 0.25 through simplex. That is why the core crate builds range proofs with secp256k1-zkp directly.
