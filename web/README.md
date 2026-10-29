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
