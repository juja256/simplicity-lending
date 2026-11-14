/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_ESPLORA_BASE_URL?: string
  readonly VITE_NETWORK?: 'liquid' | 'liquidtestnet' | 'regtest'
  // The asset pair, an asset's three together; an empty value is unset
  // (`resolve-network-config.ts`).
  readonly VITE_COLLATERAL_ASSET_ID?: string
  readonly VITE_COLLATERAL_ASSET_DECIMALS?: string
  readonly VITE_COLLATERAL_ASSET_SYMBOL?: string
  readonly VITE_PRINCIPAL_ASSET_ID?: string
  readonly VITE_PRINCIPAL_ASSET_DECIMALS?: string
  readonly VITE_PRINCIPAL_ASSET_SYMBOL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
declare module 'virtual:simplicity-sources' {
  export interface SimplicitySources {
    asset_auth: string
    script_auth: string
    private_lending: string
  }

  export const sources: SimplicitySources
}

declare module '@fontsource-variable/inter'
