# Simplicity Lending Web

V2 frontend scaffold for the Simplicity Lending protocol.

## Prerequisites

- Node.js 20.19+
- pnpm 10+
- Rust with the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`), [`wasm-pack`](https://rustwasm.github.io/wasm-pack/) (`cargo install wasm-pack --locked`) and clang, to build the private lending wasm module

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
