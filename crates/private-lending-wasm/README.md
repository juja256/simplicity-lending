# private-lending-wasm

The browser side of Simplicity Lending private offers: [`private-lending-core`](../private-lending-core)
compiled to WebAssembly with `wasm-bindgen`. The web app calls it for every private-offer
cryptographic operation, so the browser runs the same code as the contracts' tests.

## Building

From `web/`, `pnpm build:wasm` runs `wasm-pack build` and writes the package to
`web/src/wasm/private-lending/` (git-ignored). It needs the `wasm32-unknown-unknown` target,
`wasm-pack` and clang.

## API conventions

- JS names are camelCase through `js_name`; Rust names are snake_case.
- Errors are thrown strings of the form `<code>: <message>`. No exported function builds a
  `JsValue` or `JsError`, since those panic outside wasm, so native tests call the same functions.
  - Not addressed to this key (skip silently): `not-found`, `view-tag-mismatch`, `not-mine`,
    `rewind-failed`.
  - Addressed to this key but invalid (show as invalid): `terms-invalid`, `collateral-mismatch`,
    `invalid-terms`, `lender-nft-not-unique`, `nft-output-mismatch`.
  - Bad caller input: `bad-input`.
- Txids and asset ids are display-order hex; outpoints are `"<txid>:<vout>"`.
- Keys, nonces, markers and other byte strings are plain lowercase hex; hex inputs are accepted in
  either case, after trimming whitespace.
- Amounts are `u64`, which is `bigint` in JS. PSETs are base64; transactions are consensus-encoded
  hex.

## Exports

- `LendingKey`: `fromDescriptor`, `fromMasterBlindingKey`, `xOnlyPublicKey`, `fingerprint`.
- `keyFingerprint(xOnlyHex)`: the fingerprint of an x-only key.
- `viewTagMatches`, `isOwnCandidate`: cheap filters for the offers addressed to a key.
- `privateLendingProgramId()`: the marker's program id.
