// The private-lending wasm for tests, loaded in Node from its build (`pnpm build:wasm`), as the
// parity script loads it.
import fs from 'node:fs'

import * as wasm from '@/wasm/private-lending/private_lending_wasm'

wasm.initSync({
  module: fs.readFileSync(
    new URL('../wasm/private-lending/private_lending_wasm_bg.wasm', import.meta.url),
  ),
})

export { wasm }
