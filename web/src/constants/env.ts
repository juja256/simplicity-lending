import { z as zod } from 'zod'

const absoluteUrlOrPath = zod.string().refine(
  (value: string) => {
    if (value.startsWith('/')) return true
    return zod.string().url().safeParse(value).success
  },
  { message: 'must be an absolute URL or same-origin path' },
)

const envSchema = zod
  .object({
    VITE_API_URL: absoluteUrlOrPath.default('http://localhost:8000'),
    PROD: zod.boolean().default(false),
    VITE_ESPLORA_BASE_URL: zod.string().url().default('https://blockstream.info/liquid'),
    VITE_NETWORK: zod.enum(['liquid', 'liquidtestnet', 'regtest']).default('liquid'),
    VITE_WATERFALLS_URL: zod.string().url(),
    /**
     * Optional pin of the waterfalls server's age recipient. Unset (or empty), the app fetches it
     * from `${VITE_WATERFALLS_URL}/v1/server_recipient`, so a server key rotation needs no change.
     */
    VITE_WATERFALLS_RECIPIENT: zod
      .string()
      .optional()
      .transform(value => value?.trim() || undefined),
    /** Experimental SideSwap wallet connect (via their Liquid Connect server). Unset disables the connect option entirely. */
    VITE_SIDESWAP_WS_URL: zod.string().optional(),
    /** Testnet demo features: explicit test-seed login and short offer terms. */
    VITE_DEMO_MODE: zod
      .string()
      .optional()
      .default('')
      .transform(value => value === 'true'),
    VITE_GA_MEASUREMENT_ID: zod.string().optional().default(''),
  })
  .superRefine((value, ctx) => {
    if (value.VITE_DEMO_MODE && value.VITE_NETWORK === 'liquid') {
      ctx.addIssue({
        code: 'custom',
        path: ['VITE_DEMO_MODE'],
        message: 'Demo mode is only available on test networks.',
      })
    }
  })

export const env = envSchema.parse({
  VITE_API_URL: import.meta.env.VITE_API_URL,
  VITE_ESPLORA_BASE_URL: import.meta.env.VITE_ESPLORA_BASE_URL,
  VITE_NETWORK: import.meta.env.VITE_NETWORK,
  PROD: import.meta.env.PROD,
  VITE_WATERFALLS_URL: import.meta.env.VITE_WATERFALLS_URL,
  VITE_WATERFALLS_RECIPIENT: import.meta.env.VITE_WATERFALLS_RECIPIENT,
  VITE_SIDESWAP_WS_URL: import.meta.env.VITE_SIDESWAP_WS_URL,
  VITE_DEMO_MODE: import.meta.env.VITE_DEMO_MODE,
  VITE_GA_MEASUREMENT_ID: import.meta.env.VITE_GA_MEASUREMENT_ID,
})

export type AppEnv = zod.infer<typeof envSchema>

export type NetworkName = AppEnv['VITE_NETWORK']
