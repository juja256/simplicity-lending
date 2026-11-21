// LWK for tests, loaded in Node from its package, as the parity script loads it, and the contract
// sources the private lending scripts compile, read as `simplicitySourcesPlugin` reads them.
import fs from 'node:fs'

import * as lwk from 'lwk_wasm'

import type { PrivateLendingSources } from '@/simplicity/private-lending/scripts'

lwk.initSync({
  module: fs.readFileSync(new URL('../../node_modules/lwk_wasm/lwk_wasm_bg.wasm', import.meta.url)),
})

function readSimf(name: string): string {
  return fs
    .readFileSync(new URL(`../../../crates/contracts/simf/${name}.simf`, import.meta.url), 'utf-8')
    .trim()
}

export const sources: PrivateLendingSources = {
  privateLending: readSimf('private_lending'),
  assetAuth: readSimf('asset_auth'),
  scriptAuth: readSimf('script_auth'),
}

export { lwk }
