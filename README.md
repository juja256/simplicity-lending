# Simplicity lending protocol

A peer-to-peer private lending demo on Liquid testnet, with its contracts written in SimplicityHL.

A borrower addresses an offer to a lender's wallet-derived lending key. Collateral, principal, and
repayment assets and amounts are confidential on-chain; the counterparties open and verify the
terms locally. Transactions, offer state, and role-token movements remain observable. This is
confidentiality of loan terms, not transaction anonymity.

The public lending market that earlier versions also had is gone: the git tag
`public-lending-last` is the last version with it (its contracts, CLI, indexer, web pages and
docs).

## High-level mechanics

The workflow is **create → accept → claim principal → repay in full → claim repayment**.

The borrower creates an offer to a chosen lender. It locks collateral and fixes the principal, the
total repayment (principal plus interest), and the expiry height. The borrower can cancel the offer
before it is accepted.

If the lender accepts the terms, it supplies the principal, which the borrower then claims. The
borrower repays in full to take the collateral back, and the lender then claims the repayment. If
the loan is still unpaid after the expiry height, the lender can liquidate it and claim the
collateral. Partial repayments are not supported, and there is no protocol fee.

**Current limitation:** expiry does not automatically revoke a pending offer on-chain. An
uncancelled offer can be accepted after expiry and then liquidated without a guaranteed repayment
window. Confirmed cancellation is the way to withdraw it; hiding Accept in the UI is not a
contract restriction. This remains a testnet demo with incomplete manual sign-off.

## Repository structure

- **crates/** — Rust workspace, including:
  - **contracts** — the SimplicityHL contracts (private lending, asset auth, script auth) and
    their Rust bindings and tests.
  - **indexer** — backend service that indexes private offer candidates, serves them and the
    lender directory over an API, and streams `block_indexed` events.
  - **private-lending-core** and **private-lending-wasm** — private term verification,
    cryptographic operations, and browser bindings.
- **web/** — demo frontend (React/TypeScript) for borrowers and lenders.
- **docs/** — documentation site, design notes, review reports, and test evidence.

## Private loans

Open **Private loans** in the main navigation (`/app/private`; `/app` opens it too). Its summary
card shows the connected wallet's verified open offers, active loans, and total offers. Connect
Jade or use explicit test-seed login in demo mode, and compare lending-key fingerprints with your
counterparty before creating an offer. Directory names are not verified identities.

- [Private-loan user guide](docs/docs/private-loans/guide.md): setup, both roles, recovery, and troubleshooting.
- [Protocol and privacy notes](docs/docs/private-loans/protocol.md): verification, role tokens, state transitions, and trust boundaries.
- [Contract review](docs/security/2026-11-02-private-lending-contract-review.md) and [manual test results](docs/superpowers/manual/2026-10-29-private-lending-testnet.md).
- [Demo build and release notes](deployment/demo-release.md); [frontend setup](web/README.md).

## How to use

### Through Docker

From repo root:

1. Create the environment file (in the root):
   ```bash
   cp .env.example .env
   ```
2. Start the services:
   ```bash
   docker compose up --build
   ```


### Locally (without Docker)

To run the **demo frontend** (web app for borrowers and lenders), you need the **Indexer** API
running. The web app reads private offer candidates and the lender directory from it.

**Quick start (from repo root):**

1. **Indexer** — set up PostgreSQL, configure `crates/indexer` (see [crates/indexer/README.md](crates/indexer/README.md)), then:
   ```bash
   cd crates/indexer && cargo run -p lending-indexer
   ```
   By default this starts the API (port 8000). For full indexing you also need the indexer worker (`RUN_MODE=indexer`).

2. **Web** — install deps and start the dev server (see [web/README.md](web/README.md)):
   ```bash
   git submodule update --init lwk && git config submodule.recurse true
   web/scripts/build-lwk.sh
   cd web
   pnpm install
   pnpm build:wasm
   pnpm dev
   ```
   Open the URL shown (e.g. http://localhost:5173). Follow the [frontend setup](web/README.md)
   for WASM build prerequisites and the local `/api` proxy. Both frontend and indexer must use
   the same network. For the private-loan demo, follow its Liquid testnet configuration.

The contracts are built and tested with Simplex; see [Build](docs/docs/developers/build.md).
