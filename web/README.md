# Simplicity Lending Web

V2 frontend scaffold for the Simplicity Lending protocol.

## Prerequisites

- Node.js 20.19+
- pnpm 10+
- Rust with the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`), [`wasm-pack`](https://rustwasm.github.io/wasm-pack/) (`cargo install wasm-pack --locked`) and a clang that can target wasm32 plus `llvm-ar`, to build the private lending wasm module. On macOS, Apple clang cannot target wasm32: install Homebrew `llvm` and put it first on `PATH`

## Environment Variables

Copy `.env.example` to `.env` and adjust as needed.

- `VITE_API_URL` - Base URL for the indexer API.
- `VITE_ESPLORA_BASE_URL` - Base URL for Esplora.
- `VITE_NETWORK` - Network name (`liquid`, `liquidtestnet`, `regtest`).

## Stack

- Vite + React + TypeScript
- Tailwind CSS v4 (token-ready theme scaffold)
- HeroUI (`@heroui/react`)
- React Router v7 (protected route stub)
- React Query v5
- Zod v3
- ESLint + Prettier

## Install

```bash
pnpm install
```

## Build the wasm module

```bash
pnpm build:wasm
```

This compiles `crates/private-lending-wasm` into `src/wasm/private-lending/` (git-ignored). Run it
after `pnpm install` and again whenever the Rust crates change: `pnpm dev`, `pnpm build` and
`pnpm lint` need the generated package.

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
   `VITE_WATERFALLS_URL`, `VITE_WATERFALLS_RECIPIENT`).
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

### State and resume

`.e2e-private/state.json` (git-ignored) holds one record per transaction: its stage, txid, hex
and status, `built`, `broadcast` or `confirmed`. The finalized hex is saved as `built` before it is
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
