# Simplicity Lending Indexer and API

This crate indexes private lending offers on the Liquid Network and serves them to the web app. It
finds the transactions that create private offers, follows each offer's outputs through its state
transitions, and keeps the lender directory. It reads only public chain data: it never holds keys,
never opens an offer's terms, and never verifies an offer, so clients verify every offer themselves.

## Features

- Detection of transactions that create private offers, by their marker output.
- Tracking of each offer's outputs, which moves the offer from `pending` to `active`, `cancelled`,
  `repaid` or `liquidated`.
- An API that serves the offers as candidates for clients to scan, and a lender directory of
  signed lending keys.
- A server-sent event stream with one event, `block_indexed`, after each indexed block.

## Architecture

The indexer consists of two processes built from one binary: the indexing worker and a REST API.

### Indexing Engine & Pipeline

The background worker polls the Liquid Network through Esplora and keeps the database in step with
the chain. For every block height, it:
1. Fetches the block hash for the target height.
2. Retrieves all transaction identifiers (TXIDs) in that block.
3. Fetches the full transaction for each TXID.
4. Passes every transaction to the private offer tracker, which processes spends of tracked
   UTXOs and detects new offers.
5. Stores the new sync height and emits `block_indexed`, all in one database transaction.

#### Private Offer Detection

Every transaction is checked for a private offer (`private_offers` tracker). A transaction creates one when:
1. Output 2 is an `OP_RETURN` carrying a marker of the private lending program (its 4-byte program id), and the NFT outputs 0 and 1 have explicit assets (`private_lending_core::find_offer`).
2. Output 3, the pending offer, has a confidential nonce: the borrower's ephemeral public key.

The indexer reads only this public data and never verifies or opens the offer, so a candidate may be fake and clients verify every offer themselves. It stores the whole consensus-encoded creation transaction, the nonce (33-byte compressed key), the marker's view tag and encrypted lender key, the first input outpoint and the two NFT asset ids in `private_offers` (status `pending`), and the output 3 UTXO as `pending_offer` in `private_offer_utxos`. Re-indexing a creation transaction is a no-op.

#### Private Offer States

An offer starts `pending`. Each spend of a tracked UTXO moves it on, and the spending transaction's output 0 decides which way:

| Spent UTXO | Output 0 of the spending transaction | New status | New UTXOs |
|---|---|---|---|
| `pending_offer` | `OP_RETURN` burning the lender NFT (explicit asset) | `cancelled` | none |
| `pending_offer` | anything else | `active` | `active_offer` at output 0, `principal` at output 1 |
| `active_offer` | `OP_RETURN` burning the borrower NFT (explicit asset) | `repaid` | `repayment` at output 1 |
| `active_offer` | anything else | `liquidated` | none |
| `principal`, `repayment` | any | unchanged | none (the UTXO is marked spent) |

`active` means the debt is outstanding. Repayments are a list of `repayment` UTXOs: one in this contract version, possibly more in a later one. A status change sets `updated_at_height`. These statuses mean something only for offers that verify: the indexer never checks the contract, so for a fake candidate they are meaningless. No SSE event is emitted for private offers, and clients refetch on `block_indexed`.

### API Service

The API is implemented as a REST service built with `Axum`, leveraging `PostgreSQL` and `SQLx` for asynchronous, type-safe persistence. It features integrated `tracing` to provide structured logging and comprehensive request monitoring out of the box.

## Getting started

Follow these steps to get the indexer up and running in your local environment.

### Prerequisites

- Rust: Latest stable version (e.g., 1.90+)
- PostgreSQL: Version 14 or higher
- sqlx-cli: Required for database management and compile-time query validation

```bash
cargo install --version='~0.8' sqlx-cli --no-default-features --features rustls,postgres
```

### Configuration

Create a `.env` file in the **indexer crate root** (`crates/indexer`) with your database connection string. This is required for sqlx compile-time validation and runtime connectivity.

```bash
DATABASE_URL=postgres://username:password@localhost:5432/indexer_db
```

Application settings are managed via YAML files in the `configuration/` folder: `base.yaml`, `local.yaml`, and `production.yaml` (selected by `APP_ENVIRONMENT`, default is `local`).

```yaml
# Example configuration structure
application:
  port: 8000
  host: 127.0.0.1
database:
  host: "localhost"
  port: 5432
  username: "postgres"
  password: "password"
  database_name: "lending-indexer"
esplora:
  base_url: "https://blockstream.info/liquidtestnet/api"
  timeout: 10
  network: "liquidtestnet"
indexer:
  interval: 10000
  last_indexed_height: 2309541
```

An older configuration may still have an `asset_registry` section or a
`protocol_fee_keeper_asset_id` under `indexer`. The indexer ignores both.

> [!TIP]
> If `sqlx` fails to detect the `DATABASE_URL` environment variable while you are using VS Code with the `rust-analyzer` extension, you may need to restart the extension or the editor itself to refresh the environment context.

### Database Setup

The easiest way to initialize the environment is using the provided setup script. It automatically launches a Postgres container, creates the application user, and runs migrations.

Run the following from the **indexer crate root** (`crates/indexer`). Make sure Docker is running, then execute:
```bash
chmod +x scripts/init_db.sh
./scripts/init_db.sh
```
If you already have a database running and want to skip Docker, use:
```bash
SKIP_DOCKER=true ./scripts/init_db.sh
```

### Running the Project

Commands must be executed from the **indexer crate root** (`crates/indexer`) so that the `configuration/` folder is found. The application supports two execution modes via the `RUN_MODE` environment variable:
- `indexer`: Starts the blockchain indexing background worker.
- `api`: Starts the REST API service (Default).

To start the Indexer:
```bash
RUN_MODE=indexer cargo run -p lending-indexer
```

To start the API Service:
```bash
RUN_MODE=api cargo run -p lending-indexer
# Or simply (defaults to API)
cargo run -p lending-indexer
```

> [!TIP]
> For readable, pretty-printed logs in your console, pipe the output to bunyan. If you don't have it installed, run `cargo install bunyan`:
> ```bash
> RUN_MODE=indexer cargo run -p lending-indexer | bunyan
> ```

## Development & Testing

### Code Quality
To ensure code consistency and catch common issues, we use `clippy` and `rustfmt`.

Linting:
```bash
cargo clippy -- -D warnings
```

Formatting:
```bash
cargo fmt --all
```

### Running Tests

Ensure your local database is available and migrated, then run:

```bash
cargo test -p lending-indexer
```

### SQLx Offline Mode

To build the project or run checks without a live database (e.g., in CI/CD), use the `.sqlx` metadata.

Prepare metadata:
```bash
cargo sqlx prepare --workspace -- --all-targets
```

Verify without DB:
```bash
SQLX_OFFLINE=true cargo check
```

## API Reference

### OpenAPI / Swagger

When the API server is running:

- **Swagger UI:** `http://localhost:8000/swagger-ui/`
- **OpenAPI JSON:** `http://localhost:8000/api-docs/openapi.json`

The spec is generated at build time from handler annotations (`utoipa`) and matches the current DTO shapes.

Swagger UI is enabled by default (`swagger-ui` feature). Build without it for production-only deployments:

```bash
cargo build -p lending-indexer --no-default-features
```

> [!TIP]
> When running the API **directly** on port 8000, use paths without the `/api` prefix (e.g. `http://localhost:8000/private/candidates`). The OpenAPI `servers` entry uses `/api` for deployments where nginx proxies `/api/*` to the backend. Swagger UI on a direct run still lists `/api/...` in "Try it out" unless you select or override the server URL.

### Server-Sent Events

`GET /events` opens a long-lived SSE stream (`text/event-stream`).

When the indexer commits on-chain updates, it issues Postgres `NOTIFY` on channel `lending_indexer_events` with a JSON `IndexerEvent` payload. The API process listens and fans events out to all SSE subscribers.

There is one event type:

| SSE `event:` | When emitted | Suggested client action |
| :--- | :--- | :--- |
| `block_indexed` | After each indexed block | Refetch private candidates and the directory |

Example:

```
event: block_indexed
data: {"type":"block_indexed","height":2500001}
```

Clients should treat events as signals to refetch REST resources rather than as full state snapshots. Keep-alive comments are sent periodically so proxies do not close idle connections. If an nginx (or similar) reverse proxy sits in front of the API, disable response buffering for this path.

API and indexer may run as separate processes (`RUN_MODE=api` / `RUN_MODE=indexer`); events cross the process boundary via Postgres LISTEN/NOTIFY.

### Health Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | `{ "status": "ok" }` while the API process is alive. |
| `GET` | `/ready` | `{ "status": "ok" }` when the API can reach its database, otherwise `503` with `{ "status": "unavailable" }`. |

### Private lending

Private offers are found by scanning. The indexer stores every transaction whose output 0..3 layout and marker match the private program, and serves them as candidates. It never holds keys and never reads terms. A fake candidate is possible, so clients verify every offer themselves.

| Method | Endpoint | Description | Params |
| :--- | :--- | :--- | :--- |
| `GET` | `/private/candidates` | Candidates ordered by `(created_at_height, id)` | `from_height` (default 0), `to_height` (capped at the sync height), `limit` (default 100, max 500; a larger value returns `400`), `offset` (default 0). A malformed parameter returns `400`. |
| `GET` | `/private/candidates/{creation_txid}` | One candidate with its tracked UTXOs, ordered by creation height and `vout` | `404` if unknown, `400` if the txid is malformed |
| `GET` | `/private/candidates/{creation_txid}/tx` | The creation transaction as `{ "tx_hex": ... }`, consensus-encoded | same errors |

Candidate fields:

- `creation_txid`: display-order hex. The offer is output 3 of this transaction.
- `nonce`: the 33-byte compressed public key from output 3's nonce, plain hex.
- `view_tag`: a number from 0 to 255.
- `encrypted_lender_key`: 32 bytes, plain hex.
- `first_input`: `{ txid, vout }`, with the txid in display order.
- `borrower_nft_asset_id`, `lender_nft_asset_id`: display-order hex.
- `status`: `pending`, `active`, `cancelled`, `repaid` or `liquidated`. For a fake candidate the status is meaningless.
- `created_at_height`, `updated_at_height`: numbers.

Details add `utxos`: `{ utxo_type, txid, vout, created_at_height, spent_txid, spent_at_height }`. `utxo_type` is `pending_offer`, `active_offer`, `principal` or `repayment`. `spent_txid` and `spent_at_height` are `null` while the UTXO is unspent. All txids are in display order.

The list response carries `items`, `total` (candidates in the height range, ignoring paging), `limit`, `offset` and `last_indexed_height`. The indexer reads `last_indexed_height` first and returns only candidates up to it, so the height never runs ahead of the items. Before any block is indexed, `items` is empty and `last_indexed_height` is `null`.

Operator and client notes:

- `POST`, `PUT` and `DELETE` on `/private/directory...` are the API's first unauthenticated write endpoints. Rate-limit them at the reverse proxy.
- Private offers in blocks indexed before this version are not backfilled, because the stored sync height wins over the configured start height.
- Treat the indexer as untrusted. It can hide candidates or substitute directory keys, so verify every offer and show key fingerprints.

Sync recipe:

1. First sync: request pages with `from_height=0`. Fix `to_height` to the `last_indexed_height` of the first page and advance `offset` until `items` is empty. Test each candidate locally with `view_tag`, then the nonce.
2. Remember that `last_indexed_height` as `H`.
3. Next sync: request `from_height=H+1`, paging the same way.
4. To refresh known offers, refetch `/private/candidates/{creation_txid}`. Refetch on the `block_indexed` event.

### Lender directory

The directory is a public list of x-only lending keys with display names and the terms each lender accepts. An entry proves control of the key, not identity: anyone can pick any name, so clients must not treat a name as verified.

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/private/directory/challenges` | Issues a challenge: `{ challenge, expires_at }`. |
| `GET` | `/private/directory` | Entries with terms, ordered by `(display_name, pubkey)`. `limit` (default 50, max 100; a larger value returns `400`), `offset` (default 0). Returns `{ items, total, limit, offset }`, where `total` counts entries with terms. |
| `GET` | `/private/directory/{pubkey}` | One entry, with or without terms, or `404`. |
| `PUT` | `/private/directory/{pubkey}` | Creates or replaces the entry's name and terms. Body: `{ display_name, challenge, terms, signature }`; `terms` is required. Returns the entry. |
| `DELETE` | `/private/directory/{pubkey}` | Removes the entry. Body: `{ challenge, signature }`. Returns `204`, or `404` if there is no entry. |

Entries are `{ pubkey, display_name, terms, terms_published_at, created_at, updated_at }`, with unix-second timestamps. `pubkey`, `challenge` and `signature` are plain hex: 32, 32 and 64 bytes. `terms_published_at` is the time of the last put.

Terms are `{ "pairs": [ ... ] }`, 1 to 8 pairs, no two with the same principal and collateral assets. Each pair has exactly these fields:

```json
{
  "principal_asset": "<64 hex characters, display order>",
  "collateral_asset": "<64 hex characters, display order>",
  "min_apr_bps": 500,
  "max_principal_per_collateral": "5000000000",
  "min_term_days": 1,
  "max_term_days": 30,
  "min_principal": "1000",
  "max_principal": "10000000"
}
```

`u64` amounts are strings of decimal digits and `u32` fields are JSON numbers. `max_principal_per_collateral` is the most principal base units per 10^8 collateral base units. The assets differ, `max_principal_per_collateral` and `min_principal` are at least 1, `min_principal <= max_principal`, and `1 <= min_term_days <= max_term_days <= 3650`. The indexer stores the terms' encoding and serves them decoded.

An entry written before the directory carried terms has `terms` and `terms_published_at` set to `null`. It is left out of the list but still served by its key, and a put with terms lists it again. Stored terms that fail to decode are logged and served as `null`.

Writes are signed over a server challenge:

- A challenge is 32 random bytes, valid for 300 seconds and consumed by one successful write. A rejected signature does not consume it.
- The signed message is `tagged_hash("simplicity-lending/directory/v2", action || pubkey || challenge || name_length || display_name || terms)`. `action` is one byte: `1` for put, `2` for delete. `pubkey` is the 32-byte x-only key, `challenge` is 32 bytes, `name_length` is the name's length in bytes as a big-endian `u16`, `display_name` is its UTF-8 bytes (empty for delete), and `terms` is the lender terms' encoding (empty for delete). A put is signed over its name and its terms, so neither can change without the other. Version 1 signatures are not accepted. The signature is BIP340.
- Display names are 1 to 64 characters, with no leading or trailing whitespace and no control characters.

A delete body carries no name and no terms; a `terms` field on a delete is refused.

Errors: `400` for a body that is not JSON, or a malformed pubkey, challenge, signature or name; `422` (`unprocessable_entity`) for missing, malformed or invalid terms or any missing or unknown field, with a message naming the field (such as `terms.pairs[0].min_principal`) or the rule broken; `401` with `invalid signature`, or with `unknown, used or expired challenge`. A refused request does not consume its challenge.
