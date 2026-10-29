export type PrivateLendingWasm = typeof import('@/wasm/private-lending/private_lending_wasm')

let wasm: Promise<PrivateLendingWasm> | null = null

export function getPrivateLendingWasm(): Promise<PrivateLendingWasm> {
  wasm ??= (async () => {
    const loaded = await import('@/wasm/private-lending/private_lending_wasm')
    if (typeof loaded.default === 'function') await loaded.default()
    return loaded
  })()
  return wasm
}
