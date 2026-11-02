import path from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

import { simplicitySourcesPlugin } from './plugins/simplicitySourcesPlugin'

const root = path.dirname(fileURLToPath(import.meta.url))

// Link previews (Telegram, X, Facebook) ignore relative og:image URLs.
function publicUrlPlugin(publicUrl = ''): Plugin {
  return {
    name: 'public-url',
    transformIndexHtml: html => html.replaceAll('%PUBLIC_URL%', publicUrl.replace(/\/$/, '')),
  }
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const configEnv = loadEnv(mode, root, '')
  if (command === 'build' && configEnv.VITE_DEBUG_MNEMONIC?.trim()) {
    throw new Error(
      'Remove VITE_DEBUG_MNEMONIC before building. Test seeds must be entered in the wallet dialog, never embedded in a release.',
    )
  }
  if (
    configEnv.VITE_DEMO_MODE === 'true' &&
    configEnv.VITE_NETWORK !== 'liquidtestnet' &&
    configEnv.VITE_NETWORK !== 'regtest'
  ) {
    throw new Error('Demo mode requires a test network.')
  }
  if (mode === 'demo' && configEnv.VITE_NETWORK !== 'liquidtestnet') {
    throw new Error('The demo release must use Liquid testnet.')
  }
  const apiProxyTarget = configEnv.API_PROXY_TARGET
  const useLocalApiProxy = command === 'serve' && mode === 'development' && apiProxyTarget
  // A deployed API serves under `/api`; a local indexer serves at `/`, so its proxy drops the
  // prefix. Opt in with API_PROXY_STRIP_PREFIX=true.
  const stripApiPrefix = configEnv.API_PROXY_STRIP_PREFIX === 'true'
  const proxy = apiProxyTarget
    ? {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          ...(stripApiPrefix && {
            rewrite: (requestPath: string) => requestPath.replace(/^\/api/, ''),
          }),
        },
      }
    : undefined

  return {
    plugins: [
      publicUrlPlugin(configEnv.VITE_PUBLIC_URL),
      simplicitySourcesPlugin({
        configPath: './simplicity-covenants.config.json',
      }),
      react(),
    ],
    resolve: {
      alias: { '@': path.join(root, 'src') },
    },
    optimizeDeps: {
      exclude: ['@lilbonekit/lwk-web'],
    },
    server: useLocalApiProxy ? { proxy } : undefined,
    // Local smoke testing of the production bundle against the same indexer.
    preview: { proxy },
  }
})
