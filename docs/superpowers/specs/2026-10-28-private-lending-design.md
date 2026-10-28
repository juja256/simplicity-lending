# Private lending: design

Status: agreed in conversation on 2026-10-28; not yet planned.

## Intent

A borrower and a lender, typically institutions (a bank lending to a hedge fund), take a
collateralized loan on Liquid without revealing what was lent: the assets and amounts of the
collateral, the principal and the repayment, and so the interest, stay confidential on chain.
Only the two parties can read the terms.

The work extends the draft committed in `be594a8` ("add private lending":
`crates/contracts/simf/private_lending.simf`, `crates/contracts/src/programs/private_lending/`,
`crates/contracts/src/utils/confidential.rs`, `crates/contracts/tests/private_lending/`) into a
working protocol: contract, indexer, and front end.

## Goals

- A separate private contract, alongside the public `lending.simf` (not merged into it).
- All amounts and assets of a loan hidden; terms readable by the lender and the borrower only.
- A borrower addresses an offer to one lender, by the lender's public lending key.
- Lenders find the offers addressed to them in the web app.
- Life cycle: create, accept, cancel, repay in full, liquidate after expiry, claim principal,
  claim repayment.
- Jade and the app's seed wallet (development) support the private flows.
- The design leaves room for partial repayment later.
- Tests for every phase, and a soundness review of the protocol (see below).

## Non-goals

- Partial repayment (later, after the BP++ compiler work; see "Room for partial repayment").
- Mixed privacy modes (private collateral with public principal, or the reverse).
- A protocol fee on private loans: no fee keeper, no fee output. A fee tied to the interest
  would reveal the interest to whoever collects it.
- Humid support. Its `signPset` refuses PSETs with pre-blinded outputs, foreign confidential
  inputs or blinding scalars, and it never exports its coins' blinders, so the app cannot blind
  around it. Its tx-manifest flow forces covenant outputs to be explicit and refuses
  confidential covenants. Humid can come later if its `signPset` learns to blind given outputs
  with caller-specified blinders.
- SideSwap support, push notifications, identity verification of directory entries.

## Anti-goals

- The indexer must never hold a secret key or be able to read any offer's terms.
- No change to the behaviour of public loans.

## Decisions made with the user

- Separate contract; full repayment only for now.
- Offers are addressed to a lender's lending public key, chosen from a lender directory served by
  the indexer (or pasted directly).
- Scanning for offers happens in the browser; the indexer serves public candidates only.
- A private offer's creation transaction may be publicly recognizable (it carries a marker).
- Lender directory entries are added, updated and removed with a BIP340 signature by the
  lending key over a fresh server challenge (proof of knowledge).
- The lending key is derived from the wallet's SLIP-77 master blinding key. Accepted
  consequence: anyone holding the wallet's confidential descriptor (for example a watch-only
  setup) can derive it and read that party's private offers.
- No fee keeper on private loans.
- Jade (plus the seed wallet) is the PoC wallet; the private section appears only when one of
  them is connected.
- Leave room for partial repayment.
- Offers are signed by the borrower: the lender sees who sent each offer, and unsigned or
  wrongly signed offers are rejected. Borrowers can register in the directory too.
- No borrower account: private offers do not use the issuance factory; the creation transaction
  issues both NFTs directly, so one borrower's private offers are not publicly linked.
- Assets: the configured pair (L-BTC collateral, USDT principal; TEST on testnet) for the PoC.
  The contract and the terms stay asset-agnostic so other assets can be opened later.

## Calls made by the designer (open to change)

- The terms travel inside the collateral output's range proof message (see "Terms").
- A one-byte view tag in the marker, so browsers fetch full transactions only for likely matches.
- All per-offer secrets derive from the borrower–lender ECDH secret.
- The front-end crypto lives in a wasm module compiled from Rust; the TypeScript layer stays thin.
- No front-end test runner is added; the crypto is tested in Rust.

## Keys and secrets

- **Lending key.** `sk = tagged_hash("simplicity-lending/lending-key/v1", master_blinding_key)`
  reduced mod n, then negated if its public key has odd Y, so the x-only public key serves both
  BIP340 and ECDH (lift_x). Every user has one (borrowers too). The master blinding key comes
  from the wallet descriptor the app already holds: LWK's `Jade::wpkh()` returns
  `ct(slip77(<key>),elwpkh(...))`; the seed wallet's `Signer::wpkhSlip77Descriptor()` likewise.
  The secret stays in the browser; only the x-only public key leaves it (to the directory).
- **Ephemeral key** of an offer:
  `e = tagged_hash("simplicity-lending/private/v1/ephemeral", borrower_lending_sk ‖ txid ‖ vout_le32 ‖ borrower_nft ‖ lender_nft)`,
  over the creation transaction's first input (input 0's outpoint) and the two NFT asset ids it
  issues (outputs 0 and 1), the txid and the asset ids in their internal byte order and the
  secret key as its 32 bytes. Its public key is the collateral output's nonce. Deterministic, so
  the borrower recovers its offers on any device: it recomputes `e·G` from each candidate's
  input 0 and outputs 0 and 1 and compares with the nonce, then decrypts the lender's key from
  the marker (see "Marker") to get the shared secret.
- **Fresh NFTs per build.** Every secret of an offer follows from `e`, so two different creation
  transactions with the same `e` would leak to whoever sees both the collateral amount (shared
  range proof nonce), the difference of the amounts (shared blinders) or the XOR of the lenders'
  keys (shared marker pad). The NFT issuance entropy is therefore fresh randomness for every
  build, which makes every rebuild a fresh offer; a retry rebroadcasts the byte-identical
  transaction instead of building a new one from the same offer.
- **Shared secret**: the one Elements uses to rewind the collateral output's range proof
  (`Nonce::with_ephemeral_sk(e, lender_pk)` / `Nonce::shared_secret(lender_sk)`).
- **Derived values**: `tagged_hash("simplicity-lending/private/v1/<label>", shared_secret)` for:
  the view tag (first byte), and the asset and value blinders of the pending collateral, the
  active collateral, the principal and the repayment. Rewinding the pending collateral must
  yield the same blinders; a mismatch marks the offer invalid.

## Terms

The borrower puts the terms in the extra data of the collateral output's range proof message,
after Elements' standard 64 bytes (asset id ‖ asset blinder). The lender reads them in the same
rewind that finds the offer; nothing else carries them. Capacity is at least 3136 bytes of extra
data at Elements' range proof parameters, and the proof's size does not change.

rust-elements' high-level blinding API fixes the message at 64 bytes. An upstream PR adds
`RangeProofMessage::with_extra_data` and `TxOut::unblind_with_message`, but it targets elements
0.27 while this repo is on 0.25 (through simplex). Until then, build and rewind these range proofs
with secp256k1-zkp directly (`RangeProof::new(..., message, ...)`, `RangeProof::rewind`), with the
same parameters rust-elements uses (min value 1, exp 0, 52 min bits, script pubkey as extra
commit, asset generator as additional generator), so standard unblinding still works on these
outputs.

Encoding, v1 (big-endian integers):

| Field | Size |
|---|---|
| version (= 1) | 1 |
| length of the following fields | 2 |
| principal asset id | 32 |
| principal amount | 8 |
| repayment amount (principal + interest) | 8 |
| interest rate, basis points (display only) | 2 |
| loan expiration, block height | 4 |
| borrower NFT asset id | 32 |
| lender NFT asset id | 32 |
| borrower's x-only lending public key | 32 |
| BIP340 signature by the borrower's lending key | 64 |

The collateral asset and amount come from the rewind itself. The length field is required because
the rewound message is zero-padded to the proof's capacity.

The signature covers
`tagged_hash("simplicity-lending/private/v1/offer", lender_pk ‖ first input outpoint ‖ all preceding fields)`,
binding the offer to its lender, its transaction and its terms. The lender shows the sender's
directory name (if registered) and key fingerprint.

## Lender verification (soundness-critical)

Before showing an offer as acceptable, the lender's browser runs one check on the whole creation
transaction; nothing else may present an offer as valid. It has two layers:

- `private_lending_core::open_creation_as_lender(lender_key, creation_tx, program_id)`, which the
  wasm module runs unchanged: it finds the offer by the creation layout (marker of this program
  at output 2, offer at output 3, first input = input 0's outpoint, NFT ids from outputs 0 and
  1), opens it (view tag, rewind, the borrower's signature over the terms for this lender and
  first input, the rewound collateral equal to the pinned pending collateral, commitments
  included), and checks that:
  - the terms lend something and ask back at least as much (principal ≥ 1, repayment ≥
    principal), and the expiry is below the lock time threshold (500 000 000), so that
    liquidation is possible;
  - input 1 newly issues the terms' lender NFT, amount 1 and no reissuance token, so that no other
    unit can claim the repayment or liquidate;
  - outputs 0 and 1 are one explicit unit each of the terms' borrower NFT and lender NFT.
- The address checks, which need the contract (`verify_offer_as_lender(lender_key, creation_tx,
  network)` in the contracts crate; LWK's `SimplicityProgram` in the browser): recompute every
  contract parameter from the opened terms and the derived blinders
  (`PrivateLendingParameters::from_terms`: commitment hashes, expiry, NFT ids, the principal and
  repayment output script hashes), and check that the resulting pending offer address is output
  3's script pubkey and that output 1 locks the lender NFT to that offer (`script_auth` of its
  script hash).

Without the address check, a borrower could pin a repayment commitment that differs from the
amount shown in the terms, and the lender would only find out at repayment. Offers that fail any
check are shown as invalid, never as acceptable.

The borrower runs the same check with its own key (`open_creation_as_borrower` /
`verify_offer_as_borrower`) to recover its offers, and on its finished creation transaction
before broadcasting it: an offer that fails would never be accepted, and the borrower could not
rebuild it from the chain to cancel it, which would strand the collateral. The transaction
builder also asserts that the offer's parameters come from its signed terms and that input 0 is
the offer's first input. NFT issuance entropy is fresh for every build, and a retry rebroadcasts
the byte-identical transaction (see "Keys and secrets").

## Marker

Creation transactions carry an OP_RETURN output with
`program_id ‖ view_tag ‖ encrypted_lender_key` (37 bytes), where:

- `program_id` is the existing scheme: the first 4 bytes of SHA-256 of the program source
  (`SimplexProgram::get_program_id`). A future contract version therefore gets a new id.
- `encrypted_lender_key` is the lender's x-only lending key XOR
  `tagged_hash("simplicity-lending/private/v1/lender-key-pad", borrower_lending_sk ‖ txid ‖ vout_le32 ‖ borrower_nft ‖ lender_nft)`,
  the same data as the ephemeral key: the first input and the NFT ids, in internal byte order.
  Only the borrower can decrypt it; it is what lets the borrower rebuild the shared secret on a
  new device (designer's call; the lender does not need it). The NFT ids, fresh for every build,
  keep two markers from the same input 0 from revealing the XOR of their lenders' keys.

## The contract (`private_lending.simf`, v1)

Changes from the committed draft:

- Remove the protocol fee: `PROTOCOL_FEE_COMMITMENT`, `PROTOCOL_FEE_OUTPUT_SCRIPT_HASH`, the fee
  output in full repayment, and the fee keeper in `PrivateLendingParameters`/`PrivateLendingTerms`.
- Storage gets two slots, laid out like the public contract's: `is_active` and the outstanding
  debt commitment hash. As in the public contract, the debt slot holds the full debt from
  creation on: pending `(false, REPAYMENT_COMMITMENT)`, acceptance moves to
  `(true, REPAYMENT_COMMITMENT)`, full repayment spends `(true, REPAYMENT_COMMITMENT)`.
- The witness path keeps the public contract's shape, `Either<Either<accept, cancel>,
  Either<Either<partial, full>, liquidate>>`, with the partial-repayment branch reserved and
  always failing in v1.
- Blinders come from the derivations above instead of random ones.

Parameters: `BORROWER_NFT_ASSET_ID`, `LENDER_NFT_ASSET_ID`, `PENDING_COLLATERAL_COMMITMENT`,
`ACTIVE_COLLATERAL_COMMITMENT`, `PRINCIPAL_COMMITMENT`, `REPAYMENT_COMMITMENT`,
`LOAN_EXPIRATION_TIME`, `PRINCIPAL_OUTPUT_SCRIPT_HASH` (asset_auth of the borrower NFT, no burn),
`REPAYMENT_OUTPUT_SCRIPT_HASH` (asset_auth of the lender NFT, burn). A commitment hash is the
SHA-256 of the output's consensus-encoded asset and value commitments (`asset_amount_hash`).

Branches (input and output positions as in the draft):

- **Creation** (borrower, not a branch): borrower NFT to the borrower, lender NFT locked to the
  offer with script_auth, the marker, and the pending offer output (pinned collateral, blinded to
  the lender's lending key, terms in its range proof). Both NFTs are plain issuances (amount 1,
  no reissuance token) from the borrower's own inputs in this transaction, as the draft's tests
  do; no issuance factory. The "first input outpoint" used in the derivations is the creation
  transaction's input 0, a borrower coin.
- **Accept** (lender): spends the pending offer and the locked lender NFT; outputs the active
  offer (collateral under `ACTIVE_COLLATERAL_COMMITMENT`), the principal pinned to
  `PRINCIPAL_COMMITMENT` at the borrower's asset_auth, and the lender NFT.
- **Cancel** (borrower, pending only): burns both NFTs; the collateral returns to the borrower.
- **Full repay** (borrower): burns the borrower NFT; pays the repayment pinned to
  `REPAYMENT_COMMITMENT` at the lender's asset_auth; the collateral returns to the borrower.
- **Liquidate** (lender, after `LOAN_EXPIRATION_TIME`): burns the lender NFT; the lender takes the
  collateral.
- **Claims**: the borrower claims the principal with its NFT; the lender claims the repayment by
  burning its NFT.

Public: that a private offer exists, its state, NFT movements, and the expiry once the program is
revealed at its first spend. Hidden: assets and amounts of collateral, principal and repayment.

## Building transactions in the browser

1. Build the PSET with LWK as the public flows do, with wallet inputs and change, but with
   `skipBlinding()`.
2. The wasm module blinds it: pinned outputs with their derived blinders and the terms in the
   collateral's range proof; other confidential outputs with random blinders; the last one
   balancing (as `ConfidentialTransaction::finalize_with_fee` does in the draft). Input secrets
   come from LWK's wallet (`unblinded()`) for wallet coins and from the terms for covenant
   inputs.
3. For every blinded output the PSET must carry what LWK's Jade signer needs: explicit asset and
   amount, asset and value commitments, `blinding_key`, and the blind asset and value proofs.
   Jade then shows real amounts for pinned outputs.
4. Jade (or the seed signer) signs its inputs; the app finalizes the Simplicity inputs and
   broadcasts.

Contract addresses in the browser come from LWK's `SimplicityProgram`, as for public loans; add
`private_lending.simf` to `web/simplicity-covenants.config.json`.

## Indexer

- **Candidates.** Recognize creation transactions by the marker alone, in a tracker of their own
  (the public offer pipeline only looks at transactions spending an issuance factory, and its
  `offers` table requires one). Store: offer outpoint, nonce
  public key, the marker's view tag and encrypted lender key, first input outpoint of the
  creation tx, NFT asset ids, creation height.
- **States.** Follow each offer through pending, active, cancelled, repaid and liquidated from NFT
  movements and spends of the offer outpoint (cancel burns both NFTs, repay the borrower NFT,
  liquidate the lender NFT; accept moves the lender NFT out of script_auth and creates the active
  offer at output 0). No amounts.
- **Directory.** Entry: x-only lending public key, display name, timestamps. Writes need a BIP340
  signature over `tagged_hash("simplicity-lending/directory/v1", action ‖ pubkey ‖ challenge ‖
  display_name)` with a single-use challenge that expires after a few minutes.
- **API** (exact shapes to the builder): list candidates since a height (light: no range proofs),
  fetch one candidate's creation transaction, list the directory, issue a challenge, put an
  entry, delete an entry.

## Front end

- A Private section, shown when Jade or the seed wallet is connected; public pages unchanged.
- Lender: register in the directory; inbox of offers addressed to it (sync candidates, check the
  view tag, fetch and rewind on a match, verify as above, cache per lending key in the browser),
  each showing its sender; accept; claim repayment; liquidate after expiry.
- Borrower: optionally register in the directory; choose a lender from the directory or paste a
  key; create the offer; see its own offers (recovered from its key); cancel; claim principal;
  repay in full.
- Assets are the network's configured pair, as in the public flows.
- Show key fingerprints wherever a lending key is chosen, for out-of-band checks.
- Placement of pages and components is left to the builder.

## Room for partial repayment

Deployed contracts cannot change, so v1 loans stay full-repayment-only; partial repayment comes as
a new contract version alongside. v1 prepares for it with: the program id in the marker and a
version in the terms; the reserved branch and the debt slot in the contract; blinders derived from
one shared secret, so later installments can derive fresh ones; indexer and UI modelling debt as
"outstanding" with a list of repayments (one in v1).

Partial repayment needs the BP++ Simplicity verifier (in the bulletproofs repository) to take
commitments from the transaction instead of baking them in as constants. In a confidential-asset
output the value generator is also transaction data (Liquid commits `v·A + r·G` with `A` the
output's blinded asset generator), and "old debt = paid + new debt" only works on commitments
sharing a generator. That compiler change is scoped separately.

## Soundness review

To be written up and checked by the builder, at least:

- Only the addressed lender (or the borrower) can accept: acceptance needs the principal output's
  commitment opening, which only the terms give.
- Terms tampering: covered by the lender verification.
- Offer origin: the borrower's signature binds sender, lender, transaction and terms; replaying
  the terms into another transaction fails the signature.
- Each pinned output's commitment is fixed by the address; re-blinded or wrong-amount outputs fail.
- Pending and active collateral use different commitments (re-using one would need a surjection
  proof with a zero blinding difference).
- NFT authorization: cancel and repay need the borrower NFT; liquidate needs the lender NFT and
  the expiry; claims need the respective NFT.
- Directory: the proof of knowledge proves key control, not identity; a malicious indexer could
  substitute keys (privacy loss, a different counterparty, no theft) or hide candidates.
- What the view tag and the marker reveal.

## Testing

- Contract (regtest, `simplex test`): every phase succeeds; terms recovered by the lender's key;
  the borrower recovers its own offer; failures for wrong principal amount, re-blinded principal,
  re-blinded repayment, early liquidation, the reserved partial branch, wrong debt slot.
- Rust unit tests for the crypto shared with wasm: key derivation, view tag, blinder derivation,
  terms encoding including zero padding, lender verification rejecting tampered terms and bad or
  replayed borrower signatures, the encrypted lender key in the marker, PSET
  blinding producing valid blind proofs, extra-data capacity.
- A parity test: the same private offer gets the same address in Rust (simplicityhl 0.5.0) and in
  the web app's LWK (simplicityhl 0.4.1).
- Indexer integration tests: candidate detection, state tracking, directory writes with valid,
  invalid, replayed and expired signatures.
- Front end: type check, lint, build; a manual run of every phase on regtest with the seed
  wallet, and on Jade where hardware is available.

## Risks for the builder

- SimplicityHL versions differ between Rust (0.5.0) and the web app's LWK (0.4.1); the parity
  test must pass before front-end work depends on it.
- The `skipBlinding()` path has only been used with Humid; confirm it keeps blinding public keys
  and witness UTXOs for Jade and seed wallets.
- Confirm the Jade firmware version LWK's blind-proof signing needs.
