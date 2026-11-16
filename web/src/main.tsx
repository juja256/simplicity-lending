import '@fontsource-variable/inter'
import '@/styles/index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { deleteOrphanedPublicDb } from './providers/pendingTransactions/storage'

deleteOrphanedPublicDb()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
