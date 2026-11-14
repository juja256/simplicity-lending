# Simplicity Lending Web

V2 frontend scaffold for the Simplicity Lending protocol.

## Testnet demo release

```bash
pnpm lint
pnpm build:demo
pnpm preview:demo
```

`build:demo` creates the production bundle with `.env.demo`: Liquid testnet, same-origin `/api`,
and explicit test-seed login. No recovery phrase is embedded. Builds reject `VITE_DEBUG_MNEMONIC`
and mainnet demo mode. The developer Demo/System pages and debug overlays have been removed;
run `pnpm lint` and `pnpm exec tsc -b` in the terminal for diagnostics.

The app has private loans only: `/app` opens `/app/private`, and the summary card on that page
counts the connected wallet's verified private offers. The public market is in the git tag
`public-lending-last`. See the [private-loan user guide](../docs/docs/private-loans/guide.md)
for wallet setup, the borrower/lender workflow and recovery, and the
[protocol notes](../docs/docs/private-loans/protocol.md) for privacy and verification boundaries.

For a local preview against the running indexer, `.env.local` can set
`API_PROXY_TARGET=http://127.0.0.1:8000` and `API_PROXY_STRIP_PREFIX=true`. The preview server
uses that proxy too. A deployed build instead needs the `/api` reverse proxy in the deployment
stack. See [the demo release notes](../deployment/demo-release.md) for deployment checks and
the remaining contract-review and manual-checklist gaps.

## Prerequisites

- Node.js 20.19+
- pnpm 10+
- Rust with the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`), [`wasm-pack`](https://rustwasm.github.io/wasm-pack/) (`cargo install wasm-pack --locked`) and a clang that can target wasm32 plus `llvm-ar`, to build the private lending wasm module. On macOS, Apple clang cannot target wasm32: install Homebrew `llvm` and put it first on `PATH`

## Environment Variables

Copy `.env.example` to `.env` and adjust as needed.

- `VITE_API_URL` - Base URL for the indexer API.
- `VITE_ESPLORA_BASE_URL` - Base URL for Esplora.
- `VITE_NETWORK` - Network name (`liquid`, `liquidtestnet`, `regtest`).

### Asset pair

The app lends one asset pair, read from six build settings. With none of them set, a build lends
the network's default pair below. The three settings of an asset go together: set its id, decimals
and symbol to replace it, or none of them to keep the default.

| Setting                          | liquid        | liquidtestnet | regtest       |
| -------------------------------- | ------------- | ------------- | ------------- |
| `VITE_COLLATERAL_ASSET_ID`       | `6f0279…526d` | `144c65…9a49` | `5ac9f6…b225` |
| `VITE_COLLATERAL_ASSET_DECIMALS` | `8`           | `8`           | `8`           |
| `VITE_COLLATERAL_ASSET_SYMBOL`   | `LBTC`        | `tL-BTC`      | `LBTC`        |
| `VITE_PRINCIPAL_ASSET_ID`        | `ce091c…7bd2` | `38fca2…50a5` | `25b176…0064` |
| `VITE_PRINCIPAL_ASSET_DECIMALS`  | `8`           | `3`           | `2`           |
| `VITE_PRINCIPAL_ASSET_SYMBOL`    | `USDT`        | `TEST`        | `USDT`        |

The full ids are in `src/constants/resolve-network-config.ts`. An id is 64 hex characters,
decimals an integer from 0 to 18 and a symbol a non-empty string, and the collateral and principal
ids must differ. A setting left out of an asset's three (an empty value counts as set), a malformed
one, or two equal ids stops the app at startup with an error naming the setting. A new id with
the default decimals would misread every amount, hence the three go together. The icon follows
the symbol (`LBTC`, `tL-BTC`, `USDT`, `TEST`), and any other symbol gets a generic coin icon.
`pnpm check:config` checks the defaults, the replacements and the refusals.

## Stack

- Vite + React + TypeScript
- Tailwind CSS v4 (token-ready theme scaffold)
- HeroUI (`@heroui/react`)
- React Router v7 (protected route stub)
- React Query v5
- Zod v3
- ESLint + Prettier

## Install

The app uses [LWK](https://github.com/Blockstream/lwk) from the `lwk` git submodule, pinned to one
commit. Run from the repo root:

```bash
git submodule update --init lwk
git config submodule.recurse true
web/scripts/build-lwk.sh
cd web && pnpm install
```

`submodule.recurse` makes `git pull` update `lwk` too. If LWK changes after a pull, `pnpm dev` stops
and tells you to run `pnpm lwk:build`.

The build needs Rust ([rustup](https://rustup.rs)), `cargo install wasm-pack --locked`, and on macOS
`brew install llvm`. The script tells you if something is missing.

## Update LWK

```bash
cd lwk && git fetch origin && git checkout <commit> && cd ..
git add lwk
cd web && pnpm lwk:build
```

Then test the app and commit `lwk`. Pin a commit, don't follow a branch: `PsetBuilder` is
experimental and can change.

## Build the wasm module

```bash
pnpm build:wasm
```

This compiles `crates/private-lending-wasm` into `src/wasm/private-lending/` (git-ignored). Build
LWK and run `pnpm install` first (see Install). Run it again whenever the Rust crates change:
`pnpm dev`, `pnpm build` and `pnpm lint` need the generated package.

## Check browser addresses against Rust

```bash
pnpm parity
```

Initialises LWK and the private lending wasm module in Node and compares them with
`scripts/fixtures/private-lending-parity.json`, made from a regtest offer by the Rust code. It
checks the program id, the contract arguments as lender and as borrower, the output script hashes,
and the pending offer, active offer and lender NFT lock scripts, and that a tampered commitment is
rejected. It must print `private lending parity: ok` before the browser's offer addresses are
relied on (C2). Needs the wasm module built first.

## Private lending e2e on Liquid testnet

```bash
pnpm e2e:private [stage...]
```

Runs the private lending flows end to end with two seed wallets, a borrower and a lender, and
broadcasts real Liquid testnet transactions. It never touches mainnet.

### Setup

1. Build the wasm module (`pnpm build:wasm`).
2. Put two testnet-only seed phrases in `.env.e2e.local` (git-ignored by `*.local`):
   `PRIVATE_E2E_BORROWER_MNEMONIC` and `PRIVATE_E2E_LENDER_MNEMONIC`. Environment variables of the
   same names take precedence. The script never prints them.
3. Esplora and waterfalls come from `.env.liquidtestnet` (`VITE_ESPLORA_BASE_URL`,
   `VITE_WATERFALLS_URL`). The waterfalls key is fetched from the server unless
   `VITE_WATERFALLS_RECIPIENT` pins one.
4. Fund both wallets with tL-BTC and TEST from a Liquid testnet faucet, in the amounts under
   Funding. `pnpm e2e:private wallets` prints both addresses.

### Stages

With no stage named, every stage below runs in this order.

- `wallets`: prints each wallet's address, confirmed balances and lending-key fingerprint. A
  wallet with too few confirmed tL-BTC coins is split into 6 × 15 000 tL-sats (borrower) or
  3 × 5 000 (lender).
- `create`: the borrower creates an offer to the lender that expires 1 440 blocks after the tip.
  It builds twice from the same coins and checks that the NFTs and the output 3 nonce differ, runs
  its self-check and broadcasts; the lender then opens and verifies the offer.
- `accept`: the lender accepts the `create` offer: the active offer, the principal locked to the
  borrower NFT, and the lender NFT to the lender.
- `claim-principal`: the borrower claims the principal with its borrower NFT.
- `repay`: the borrower repays in full. The borrower NFT is burned, the repayment is locked to the
  lender NFT, and the collateral comes back.
- `claim-repayment`: the lender claims the repayment, burning its lender NFT.
- `cancel`: a new offer (record `cancel-create`), which the borrower cancels (record `cancel`).
  Both NFTs are burned and the collateral comes back to the borrower.
- `liquidate`: a new offer that expires 3 blocks after the tip (`liquidate-create`), which the
  lender accepts (`liquidate-accept`). While the tip is below the expiry, a liquidation must be
  refused with `expiry-not-reached` before anything is fetched or built: it is tried once the
  acceptance is broadcast, and again once it confirmed. The script then waits for the expiry and
  liquidates (`liquidate`).
- `scan`: reads the local testnet indexer (below) and broadcasts nothing. Each wallet syncs its
  offers from an empty store: the lender must find exactly the three e2e offers (`create`,
  `cancel-create`, `liquidate-create`), verified as lender, and the borrower the same three as
  borrower. The sync must page as the indexer's sync recipe says and fetch only the transactions
  of candidates that pass the view-tag or own-nonce check, and a re-sync must start right after
  the stored height and keep the same offers. A fresh random key must find nothing. A local proxy
  then plays a hostile indexer that serves `create`'s candidate with `cancel-create`'s
  transaction: `create` must come out invalid, never verified, and the next sync, against the
  honest indexer, must check it again and find it verified. A cheap check that throws anything but
  `bad-input` must fail the sync and leave the stored state unchanged. Last, the lender registers
  "E2E Lender" in the directory, sees it listed, gets a 401 for a write signed over another name,
  and removes the entry.

Each stage prints its txids and the PSET it built, with the checks it ran. It fails if a covenant
or NFT input's witness outweighs the constant its builder gives LWK for the fee: on chain, and in
every stage but `claim-principal` also before broadcasting. The liquidation must also carry the
expiry as its lock time, with sequence `0xfffffffe` on the offer input, and be mined after the
expiry.

The dry stages `create-dry`, `accept-dry`, `claim-principal-dry`, `repay-dry`,
`claim-repayment-dry`, `cancel-dry` and `liquidate-dry` build, check, sign and finalize their
stage's transaction from the wallets' current coins, and never save or broadcast it. They run
only when named, and need the records the real transaction would spend: `cancel-dry` rebuilds the
cancellation of the `cancel-create` offer, and `liquidate-dry` the liquidation of the
`liquidate-accept` one, which below the expiry checks the refusal instead.

`repay-hostile-dry` checks that a hostile indexer cannot lead the borrower to repay while the
principal may be unclaimed, which would burn the only key to it. It reads the `create` offer's
candidate from the local testnet indexer (below) and wraps it in memory as an active loan. With
the principal left out, or listed as spent by the creation, the app's rules derive no repay inputs,
and the builder refuses the creation's borrower NFT with `principal-not-claimed` before building.
With the principal listed as spent by the repayment, the builder refuses that outpoint the same
way, although it holds the borrower NFT. The honest candidate passes every check up to the build.
Nothing is built, signed or broadcast.

### Local testnet indexer

The `scan` stage, and the app on testnet (`VITE_API_URL` in `.env.liquidtestnet`, which the e2e
script reads too), use a local indexer of Liquid testnet with its own database. A `scan` rerun
needs a fresh database for the e2e state it reads, indexed from just below that state's first
creation (`INDEXER__LAST_INDEXED_HEIGHT`, below); the commands use
`lending-indexer-testnet-v2p1` as the example name. Never point the indexer tests at that
database, nor run them while this indexer uses Postgres. From `crates/indexer`, with Postgres on
`localhost:5432`:

```bash
# Once: sqlx-cli, then the database and its migrations.
cargo install --version='~0.8' sqlx-cli --no-default-features --features rustls,postgres --locked
DATABASE_URL=postgres://postgres:password@localhost:5432/lending-indexer-testnet-v2p1 \
  sqlx database create
DATABASE_URL=postgres://postgres:password@localhost:5432/lending-indexer-testnet-v2p1 \
  sqlx migrate run

# Two processes, each in its own shell with these exports.
export SQLX_OFFLINE=true DATABASE__DATABASE_NAME=lending-indexer-testnet-v2p1
export ESPLORA__BASE_URL=https://blockstream.info/liquidtestnet/api
RUN_MODE=indexer INDEXER__LAST_INDEXED_HEIGHT=<height> cargo run -p lending-indexer
RUN_MODE=api cargo run -p lending-indexer
```

- `INDEXER__LAST_INDEXED_HEIGHT` is the block before the first one indexed: a height just below
  the first e2e creation (the tip before the run). It applies only to an empty database;
  afterwards the stored sync height wins.
- `ESPLORA__BASE_URL` replaces `configuration/base.yaml`'s `liquid.network` esplora with the one
  the e2e script uses.
- The API listens on `http://localhost:8000`. The indexer catches up at 30 to 45 blocks a minute;
  `curl 'http://localhost:8000/private/candidates?limit=1'` shows its `last_indexed_height`, and
  `scan` fails until it has passed every e2e creation.

The indexer sends no CORS headers, so a browser cannot read it from the dev server's origin. To
run the app against it, let the dev server proxy it under its own origin and drop the `/api`
prefix, which the local indexer does not serve. In `.env.local` (git-ignored), over the testnet
settings from `.env.liquidtestnet`:

```bash
VITE_API_URL=/api
API_PROXY_TARGET=http://127.0.0.1:8000
API_PROXY_STRIP_PREFIX=true
```

Then `pnpm dev`. `API_PROXY_STRIP_PREFIX` is off by default, so the proxy to a deployed API (which
serves under `/api`) is unchanged. The e2e script reads `VITE_API_URL` from `.env.liquidtestnet`,
not `.env.local`, and keeps calling the indexer directly.

### State and resume

`.e2e-private/state.json` (git-ignored) holds three maps. `records` has one record per
transaction: its stage, txid, hex and status, `built`, `broadcast` or `confirmed`. `nftReceivers`
has the borrower NFT receiver of each creation, by its record. `walletIdentities` has each
wallet's identity script, saved by the `wallets` stage. A file that holds the records only, from
before the other two maps, is still read. The finalized hex is saved as `built` before it is
broadcast. A re-run never rebuilds a recorded transaction: it rebroadcasts the saved hex ("already
known" counts as success) and waits for the confirmation. A stage whose records are all
`confirmed` is skipped, but its on-chain checks run again. The script waits for one confirmation
between steps, polling esplora every 10 s for up to 10 minutes; a timeout leaves the record to
resume. Removing a record makes the next run build a new transaction, and a new offer for a
creation, which needs the funds again.

### Funding

Every run first checks that both wallets hold, in confirmed coins, what the transactions without a
`confirmed` record still need, and exits 1 naming each shortfall and the address to fund. Each
stage checks its own need again right before it builds. The needs, per record, are in
`STAGE_NEEDS` (`scripts/e2e/env.ts`), from these amounts: collateral 20 000 tL-sats, principal
1 000 TEST units, repayment 1 100 TEST units, and 2 000 tL-sats of fee budget per transaction. A
creation needs 2 × the collateral, as it takes two coins besides the collateral. From an empty
state, the stages need:

- the borrower: 132 000 tL-sats and 100 TEST units (the interest; the principal comes from the
  claim);
- the lender: 8 000 tL-sats and 2 000 TEST units.

The cancellation returns the borrower's collateral, and the liquidation pays its collateral to the
lender.

## Run

```bash
pnpm dev
```

## Add Icon

Generate a new icon component in `src/components/icons`.

Command:

```bash
pnpm add-icon <icon-name> "<svg>...</svg>"
```

Example:

```bash
pnpm add-icon coins "<svg viewBox='0 0 24 24'>...</svg>"
```

Notes:

- If SVG content is omitted, the script reads SVG from your clipboard.
- The generated component is normalized to use `currentColor` and saved as `<name>-icon.tsx`.

## Lint

```bash
pnpm lint
```

## Docker

See [`deployment/`](../deployment/README.md) for the Docker build and compose stack.
