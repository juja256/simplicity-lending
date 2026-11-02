# Liquid testnet demo release

This release preparation targets Liquid testnet with explicit test-seed login and Jade support.
It does not publish or deploy the application.

## UI changes

- Main navigation includes Dashboard, Borrow, Supply, and Private loans, including before wallet connection.
- Dashboard private-loan summary shows open offers, active loans, and total verified offers for the connected wallet. Loading, empty, unsupported-wallet, failed-scan and unsent-transaction states are explicit. Decrypted terms remain in the existing session-scoped cache.
- Public-market statistics and public borrowing/supply cards are labelled separately.
- Developer Demo/System pages, their routes, query devtools, and the Vite checker overlay are removed. Lint and TypeScript remain terminal/build checks.
- The footer shows the network and test-asset faucet, without API endpoint diagnostics.
- Wallet refresh invalidates the cached creation-coin query, addressing the stale coin-count warning observed during faucet funding. Testnet pages do not request USD prices.

## Build and preview

From `web/`, with dependencies and generated WASM installed as described in its README:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm build:demo
pnpm preview:demo --host 127.0.0.1 --port 4173
```

`.env.demo` supplies public testnet settings. `VITE_DEBUG_MNEMONIC` is unsupported and causes a
build failure if present; test-seed wallets are connected explicitly through the wallet dialog.
Demo mode on mainnet also fails. The Docker context excludes local environment files, e2e state,
seed notes, and package caches. Existing local seed files are preserved and ignored by Git.

The preview can use the local indexer through `API_PROXY_TARGET=http://127.0.0.1:8000` and
`API_PROXY_STRIP_PREFIX=true` in `.env.local`. This proxy is for local testing, not a backend
included in the static bundle.

For a deployed demo, use `deployment/Dockerfile.web` and `deployment/docker-compose.yml` from
the repository root, as in the deployment README. The example compose environment selects
Liquid testnet and enables explicit test-seed login. Set the real public origin and server-side
database credentials in the untracked deployment environment file; serve the app over HTTPS
for Jade WebSerial and configure `/api` forwarding, including the indexer event stream. Rebuild
the web image when public build settings change. A frontend-only static upload cannot provide
the indexer/database services.

## Outstanding release decisions

Deployment configuration review on 2026-11-02 corrected backend environment overrides (network,
initial scan height and fee asset), public-origin build wiring, and SSE proxy buffering. Nginx
now compresses WASM and caches hashed assets. Dockerfiles copy only template directories, and
the local Compose environment file is excluded from Git and the Docker context. The migration
CLI is constrained to SQLx 0.8, matching the application. GitLab demo defaults retain test-seed
login and no longer pass a debug mnemonic argument.

Compose validation against the public example, non-default backend template rendering, shell
syntax, and an isolated `nginx -t` check passed. The subsequent
[local Compose check](local-compose-check.md) built both images on Linux ARM64, applied all
migrations, verified healthy database/API/web services, checked private endpoints, SPA navigation,
both WASM assets, caching/compression, and SSE keep-alives. The browser rendered the dashboard
and private-loan navigation with Jade and demo seed choices. Live indexing remains unverified:
Blockstream returned HTTP 429, so the isolated test indexer was stopped to avoid further requests.

Validation on 2026-11-02: full ESLint, TypeScript/demo production build, the three offline
wallet-sync regression checks, and both build guards (embedded debug mnemonic and mainnet
demo mode) passed. The build retains the existing large-chunk/mixed-import warnings.
The connected lender dashboard rendered the new navigation and private-summary error/retry
states, but the successful loaded summary was not verified: the user reported rate limiting
and asked to commit/merge, deferring further browser checks until later. Production-preview
browser smoke testing was subsequently completed for the disconnected UI in the Docker check;
wallet-connected counts and transaction flows were not repeated there. This is not full sign-off.

- The [contract review](../docs/security/2026-11-02-private-lending-contract-review.md) found M-01:
  expired pending offers remain acceptable on-chain and can then be liquidated immediately.
  The UI hiding Accept is not a contract restriction. This UI cleanup does not change the contract.
  Resolve or explicitly accept this behavior before presenting the protocol as ready for valuable assets.
- [Task 11 results](../docs/superpowers/manual/2026-10-29-private-lending-testnet.md) contain
  uncaptured Jade NFT/domain/warning observations and other partial assertions. Optional Jade
  claim/retry/repayment checks were skipped at the user's request. Do not mark full sign-off complete.
- The wallet-scan aliasing mitigation and its [library report](../docs/bug-reports/2026-11-02-lwk-web-concurrent-scan-hang.md)
  are included in the merged demo preparation. One successful browser retry supports the mitigation; it is
  not proof that every WASM concurrency hazard is eliminated.
- Existing React duplicate-key/PressResponder warnings were observed during earlier manual testing;
  removing developer overlays does not fix or suppress runtime warnings.
- The build still includes substantial LWK/private-contract WASM assets. Allow for their initial
  download during demos; compression and caching should be enabled at the serving layer.

The currently active Jade test loan is documented in the checklist; no transaction is submitted
by building or previewing this release.
