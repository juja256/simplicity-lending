# Indexer / Backend Setup

## Install dependencies

### Install cargo

```bash
curl https://sh.rustup.rs -sSf | sh

cargo --version
```

### Install simplex

Install Simplex with its installer, pinned to the commit the repository uses (see
[Versions](../../docs/docs/developers/versions.md)):

```bash
curl -fsSL https://smplx.simplicity-lang.org | bash
~/.simplex/bin/simplexup --commit 1945d11b47fff8838c3e99c210133519a9522324
```

Add `~/.simplex/bin` to `PATH`.

## Make sure you have .env file in the root

From repo root:

```bash
cp .env.example .env
```

## Build contracts

From repo root:

```bash
cd crates/contracts

simplex build
cargo build
```

## Run docker compose

From repo root:

```bash
docker compose up -d --build
```

After this, the indexer API is at http://localhost:8000 (`API_PORT` in `.env`), for example
http://localhost:8000/private/candidates.
