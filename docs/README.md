# Simplicity Lending docs

Documentation site for the lending protocol, built with [Docusaurus](https://docusaurus.io/).

## Private loans

- [User guide](docs/private-loans/guide.md): wallets, dashboard, borrowing, lending, and troubleshooting.
- [Protocol and privacy](docs/private-loans/protocol.md): confidential terms, verification, state transitions, and limitations.
- [Focused contract review](security/2026-11-02-private-lending-contract-review.md).
- [Manual testnet checklist and results](superpowers/manual/2026-10-29-private-lending-testnet.md).

The two guides appear under **Private loans** in the documentation site's sidebar. Review reports
and manual evidence remain repository documents.

## Installation

```bash
pnpm install
```

## Local development

```bash
pnpm start
```

## Build

```bash
pnpm build
```

Static output is written to `build/`.
