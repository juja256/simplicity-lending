# Dockerized Simplicity Lending Deployment

This deployment stack runs:

- `postgres` for indexed state
- `migrate` to apply the SQLx schema before the app starts
- `api` for the lending protocol HTTP API
- `indexer` for background chain indexing
- `web` for the frontend (public and private loans), including `/api` and `/esplora` reverse proxies

This configuration targets the Liquid testnet demo. See the [release notes](demo-release.md)
for validation status and unresolved contract/manual-test findings, and the
[private-loan guide](../docs/docs/private-loans/guide.md) for the user workflow.
The [local Compose check](local-compose-check.md) records the successful image/runtime checks
and the remaining upstream rate-limit blocker.

## Layout

Most deployment knobs live in `deployment/configs`:

- `compose.env.example`: the single env file template for compose, image build args, and runtime rendering
- `backend/*.template`: rendered into the indexer `configuration/` directory
- `nginx/default.conf.template`: reverse proxy and SPA serving rules

## Quick Start

From `deployment/`:

```bash
cp ./configs/compose.env.example ./configs/compose.env
# Edit compose.env: set your domain, registry settings, and database password first.
docker compose --env-file ./configs/compose.env -f docker-compose.yml config --quiet
docker compose --env-file ./configs/compose.env -f docker-compose.yml up --build -d
```

The stack publishes only the web container on `WEB_PORT`. With the example values, the browser calls:

- `/api/*` -> internal `api:8000`
- `VITE_ESPLORA_BASE_URL` -> the public Esplora/explorer origin

The same-origin `/api` shape avoids browser CORS issues for normal deployment. `web`
reads its public settings from Vite at image build time, so rebuild the web image after
changing any `VITE_*` value.

The web image builds the private-lending WASM from Rust before building the frontend; no locally
generated WASM is required. Compose passes the public environment explicitly to `pnpm build`.
The separate local `pnpm build:demo` command uses `.env.demo`; Docker does not depend on that mode.
`PUBLIC_ORIGIN` becomes `VITE_PUBLIC_URL` for absolute social-preview URLs.

To test with a separate environment file and database volume, set `COMPOSE_ENV_FILE` to the
absolute path of that file, pass the same file with `--env-file`, and choose a distinct project
name with `-p`. For a localhost-only test, set `WEB_PORT=127.0.0.1:18080` and
`PUBLIC_ORIGIN=http://127.0.0.1:18080`. Disable asset registry submissions with
`ASSET_REGISTRY_URL=`. Each project gets its own `postgres_data` volume; do not use `down -v`
against a project whose indexed state you need to retain.

The stack itself serves HTTP on `WEB_PORT`. Terminate HTTPS at a reverse proxy/load balancer
before using Jade on a public hostname. Forward `/api/events` as an unbuffered event stream
through that outer proxy as well. Setting `PUBLIC_ORIGIN` does not provision DNS or certificates.

`configs/compose.env` is ignored by Git and excluded from Docker build context. Images copy only
their required template directories; runtime credentials are supplied through Compose, not baked
into the image. Use a long random URL-safe database password: the migration script interpolates
it into a PostgreSQL URL without URL-encoding. The default placeholder must be replaced.

## Required Configuration

Set these values in `deployment/configs/compose.env`:

- `PUBLIC_ORIGIN`: the final public HTTPS origin, for example `https://lending.example.com`
- `WEB_PORT`: host port mapped to the public web server
- `VITE_API_URL`: indexer API URL baked into `web`, for example `/api` for the same-origin nginx proxy or `https://lending.example.com/api`
- `VITE_ESPLORA_BASE_URL`: public Esplora/explorer base URL, for example `https://blockstream.info/liquidtestnet`
- `VITE_NETWORK`: selects both frontend and rendered backend network; keep `liquidtestnet` for this demo
- `VITE_WATERFALLS_URL`: Waterfalls server base URL for LWK sync
- `VITE_WATERFALLS_RECIPIENT`: optional pin of the Waterfalls server's age recipient; leave unset to fetch it from `<VITE_WATERFALLS_URL>/v1/server_recipient` at startup
- `VITE_DEMO_MODE`: `true` for the Liquid testnet demo with explicit test-seed login; rejected on mainnet. Embedded debug mnemonics are no longer supported.
- `VITE_SIDESWAP_WS_URL`: optional experimental SideSwap wallet connect server URL; leave unset to disable that connect option
- `INDEXER_ESPLORA_BASE_URL`: the Esplora API used by the backend indexer
- `WEB_ESPLORA_API_UPSTREAM`: the Esplora API proxied by nginx, for example `https://blockstream.info/liquidtestnet/api`
- `INDEXER_POLL_INTERVAL_MS`: background polling interval
- `PROTOCOL_FEE_KEEPER_ASSET_ID`: protocol-fee keeper asset tracked by the indexer
- `INDEXER_LAST_INDEXED_HEIGHT`: last already-indexed height for a new database; scanning starts at this height plus one. Existing database sync state takes precedence. Set it below the earliest offer you need, including private offers; changing it does not rewind an existing database.
- `ASSET_REGISTRY_DOMAIN`: your issuer domain; use the domain you control and serve the proof route from it
- `ASSET_REGISTRY_URL`: asset registry submission endpoint, or empty to disable submissions
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`: database connection settings

## GitLab Image Builds

The GitLab `build_web` job passes the `VITE_*` variables above as Docker build args. It
defaults to Liquid testnet values and `/api` for the same-origin nginx API proxy, while
allowing GitLab project variables with the same names to override those defaults. It
still fails early when any required value is empty after defaults are applied.

On the default branch, `build_backend` and `build_web` run automatically. On feature
branches they remain manual so a mirrored PR branch can be tested without deploying
every pushed commit.

## CORS, Proxying, and Other Deployment Pitfalls

- The default deployment keeps the API private and exposes it through nginx as `/api`. In that shape, browser CORS is mostly avoided.
- The current backend does not enable cross-origin browser access. Keep the browser on the same public origin as `/api`, or add backend CORS support before exposing the API on a separate origin.
- The frontend also makes browser-side Esplora calls through `VITE_ESPLORA_BASE_URL`.
- This deployment assumes the app is served from a domain root, not a subpath. If you need a subpath deployment, you will need additional Vite base-path work.

## Useful Commands

From `deployment/`:

```bash
docker compose --env-file ./configs/compose.env -f docker-compose.yml config
docker compose --env-file ./configs/compose.env -f docker-compose.yml build
docker compose --env-file ./configs/compose.env -f docker-compose.yml up -d
docker compose --env-file ./configs/compose.env -f docker-compose.yml logs -f web api indexer
docker compose --env-file ./configs/compose.env -f docker-compose.yml down
```

## Smoke Checks

Once the stack is running, verify:

- `http://localhost:${WEB_PORT}/`
- `http://localhost:${WEB_PORT}/api/health`
- `http://localhost:${WEB_PORT}/api/ready`
- `http://localhost:${WEB_PORT}/api/offers?limit=1`
- `http://localhost:${WEB_PORT}/api/private/candidates?limit=1`
- `http://localhost:${WEB_PORT}/app/private` (direct SPA navigation)

Check event-stream delivery without buffering:

```bash
curl -N --max-time 20 "http://localhost:${WEB_PORT}/api/events"
```

Expect a `keep-alive` comment after about 15 seconds, or an event sooner. Curl's time-limit exit
is expected for this intentionally open stream. Confirm that the indexer has reached the blocks
containing your offers before diagnosing empty private-loan lists. A healthy API does not mean
the indexer is caught up. Neither this proxy nor the UI removes upstream Esplora/Waterfalls rate
limits; use endpoints with sufficient capacity and allow throttled services to recover.

Nginx compresses JavaScript, CSS, JSON and WASM, caches hashed `/assets/` files, and asks browsers
to revalidate the SPA shell. Keep this behavior at any outer proxy/CDN so releases can load fresh
HTML while reusing unchanged large WASM files.
