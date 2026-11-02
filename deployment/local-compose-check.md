# Local Compose validation — 2026-11-02

Tested the current working tree using `deployment/docker-compose.yml`, project name
`simplicity-smoke`, on Docker Desktop with native Linux ARM64 images. No public deployment,
wallet signing, loan creation or asset-registry submission was performed.

## Isolation and configuration

- Web binds only `127.0.0.1:18080`; the database and API publish no host ports.
- The project uses its own `simplicity-smoke_postgres_data` volume, database and generated
  URL-safe password. The existing development PostgreSQL container on port 5432 was untouched.
- A temporary environment file supplies both Compose interpolation and service `env_file`
  through `COMPOSE_ENV_FILE`. No credentials were committed or printed.
- Liquid testnet, explicit demo seed login, and `PUBLIC_ORIGIN=http://127.0.0.1:18080` were selected.
- Registry submissions were disabled. The initial scan height was 2687612, just before the local
  development indexer's last known height at test setup. This is a narrow smoke scan, not a
  historical reindex of the existing demo loans.

## Results

| Check | Result |
| --- | --- |
| Compose configuration | Passed with a separate environment file and project. |
| Backend image | Built successfully, including pinned Simplex contract generation, release indexer and SQLx 0.8.6 CLI. The same built image was tagged for API, migration and indexer services, which use the same Dockerfile. |
| Web image | Built successfully: Rust/WASM compilation, frozen pnpm install, TypeScript and Vite production build. |
| Migrations | All three applied successfully: base tables, private offers, lender directory. Migration service exited 0. |
| PostgreSQL/API/web | Healthy. `/api/health` and `/api/ready` returned 200. |
| Public and private APIs | `/api/offers?limit=1`, `/api/private/candidates?limit=1` and `/api/private/directory` returned 200 with JSON. |
| SPA deep link | `/app/private` returned the app shell with `Cache-Control: no-cache`. |
| Static assets | JS and both LWK/private-lending WASM assets had gzip and immutable cache headers. WASM MIME type was `application/wasm`; a missing asset returned 404 rather than HTML. |
| SSE | `/api/events` returned `text/event-stream` and delivered an unbuffered keep-alive at 15 seconds. A real indexed-block event was not observed. |
| Browser | Docker-served dashboard rendered; “Open private loans” navigated correctly; disconnected private page worked; wallet picker offered Jade TESTNET and Seed phrase DEMO ONLY. No wallet was connected. |
| Indexer startup | Connected to the new database and initialized its watch caches. Fetching the remote chain tip failed with HTTP 429. |

The private-candidates response had `last_indexed_height: null` because no block was indexed.
Successful health checks and empty lists therefore do not establish discovery of existing loans.

## Remaining blocker and service state

Blockstream's public Liquid testnet Esplora returned **429 Too Many Requests** both from the host
and the container. Indexer polling was set to 60 seconds, then the test indexer was deliberately
stopped after the error was confirmed. Docker reported exit 137 after the stop timeout and
`OOMKilled=false`; this was the manual stop, not evidence of a build failure or memory exhaustion.

At completion, web, API and the isolated database were left running for inspection at
`http://127.0.0.1:18080/app`. The migration job had completed and the test indexer was stopped.
The browser is disconnected and the isolated database contains no indexed offer history.

On this machine, `/tmp/simplicity-compose-smoke-current` records the temporary environment-file
path, without copying its contents into the report. While that file remains available, from the
repository root:

```sh
COMPOSE_TEST_ENV=$(cat /tmp/simplicity-compose-smoke-current)
docker compose -p simplicity-smoke --env-file "$COMPOSE_TEST_ENV" -f deployment/docker-compose.yml ps -a

# After upstream access has recovered:
docker compose -p simplicity-smoke --env-file "$COMPOSE_TEST_ENV" -f deployment/docker-compose.yml start indexer

# Stop this test stack, preserving its database volume:
docker compose -p simplicity-smoke --env-file "$COMPOSE_TEST_ENV" -f deployment/docker-compose.yml down
```

An AMD64 build, public HTTPS ingress, real block-event delivery, historical private-offer
discovery, wallet connection and transaction signing remain outside this deployment check.
The known contract finding and manual checklist gaps in [the release notes](demo-release.md)
are unchanged. Build output retained the existing large-chunk/mixed-import warnings; the locked
SQLx CLI dependency build also warned about yanked `log`/`spin` versions but completed successfully.
