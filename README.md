# Simplicity lending protocol

A pure SimplicityHL implementation of a peer-to-peer lending protocol.

## High-level mechanics

Borrowers create "borrowing offers" with specified _collateral amount_, _lending duration_, and _principal asset amount_ (interest) they are willing to pay for the credit settlement. They also specify the _amount of principal_ they are willing to receive for the pledged collateral.

The Borrower can cancel the initial offer before it is accepted.

If a Lender is satisfied with such conditions, they provide principal to the borrower, creating a lending contract.

At any point in time before the lending contract expiry, the Borrower can repay the principal amount with interest and take their collateral back.

In case the Borrower fails to pay interest before the lending contract expiry, the Lender can liquidate the position and claim collateral for themselves.

## Repository structure

- **crates/** — Rust workspace, including:
  - **CLI** — command-line tools for the lending protocol (building and signing transactions).
  - **Contracts** — Simplicity contracts and covenant logic for the lending protocol.
  - **Indexer** — backend service that indexes offers and exposes an API for the web app.
  - **private-lending-core** and **private-lending-wasm** — private term verification, cryptographic operations, and browser bindings.
- **web/** — demo frontend (React/TypeScript) for borrowers and lenders.
- **docs/** — documentation site, design notes, review reports, and test evidence.

## Private loans

The Liquid testnet demo supports private loans alongside the public market. A borrower addresses
an offer to a lender's wallet-derived lending key. Collateral, principal, and repayment assets
and amounts are confidential on-chain; the counterparties open and verify the terms locally.
Transactions, offer state, and role-token movements remain observable. This is confidentiality
of loan terms, not transaction anonymity.

Open **Private loans** in the main navigation, or **Open private loans** on the dashboard
(`/app/private`). The dashboard summarizes the connected wallet's verified open offers, active
loans, and total offers separately from public-market statistics. Connect Jade or use explicit
test-seed login in demo mode, and compare lending-key fingerprints with your counterparty before
creating an offer. Directory names are not verified identities.

The workflow is **create → accept → claim principal → repay in full → claim repayment**.
An unaccepted offer can be cancelled; an unpaid active loan can be liquidated after its expiry
height. Private loans issue their own role tokens and do not require a public borrower account.

**Current limitation:** expiry does not automatically revoke a pending offer on-chain. An
uncancelled offer can be accepted after expiry and then liquidated without a guaranteed repayment
window. Confirmed cancellation is the way to withdraw it; hiding Accept in the UI is not a
contract restriction. This remains a testnet demo with incomplete manual sign-off.

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

To run the **demo frontend** (web app for borrowers and lenders), you need the **Indexer** API running. The web app talks to it to list and manage offers.

**Quick start (from repo root):**

1. **Indexer** — set up PostgreSQL, configure `crates/indexer` (see [crates/indexer/README.md](crates/indexer/README.md)), then:
   ```bash
   cd crates/indexer && cargo run -p lending-indexer
   ```
   By default this starts the API (port 8000). For full indexing you also need the indexer worker (`RUN_MODE=indexer`).

2. **Web** — install deps and start the dev server (see [web/README.md](web/README.md)):
   ```bash
   cd web
   pnpm install
   pnpm build:wasm
   pnpm dev
   ```
   Open the URL shown (e.g. http://localhost:5173). Follow the [frontend setup](web/README.md)
   for WASM build prerequisites and the local `/api` proxy. Both frontend and indexer must use
   the same network. For the private-loan demo, follow its Liquid testnet configuration.

**CLI** and **Contracts** are used for building/signing lending transactions and covenant logic; see the respective crates under `crates/` for development and usage.
