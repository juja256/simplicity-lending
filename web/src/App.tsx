import { useEffect, useState } from 'react'
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
} from 'react-router-dom'

import BorrowerLayout from '@/areas/borrow/BorrowerLayout'
import LenderLayout from '@/areas/lend/LenderLayout'
import { WalletGate } from '@/areas/WalletGate'
import { RoutePath } from '@/constants/routes'
import { AppProviders } from '@/providers/AppProviders'
import { initAnalytics, trackPageView } from '@/utils/analytics'

import ErrorBoundary from './components/ErrorBoundary'
import LandingPage from './pages/Landing'
import PrivatePage from './pages/Private'

function ProvidersLayout() {
  const { pathname } = useLocation()
  // Once true, stays true: keeps providers mounted so the wallet session is not lost
  const [hasEnteredApp, setHasEnteredApp] = useState(() => isAppPath(pathname))

  if (!hasEnteredApp && isAppPath(pathname)) setHasEnteredApp(true)

  useEffect(() => {
    initAnalytics()
  }, [])

  useEffect(() => {
    trackPageView(pathname)
  }, [pathname])

  return hasEnteredApp ? (
    <AppProviders>
      <Outlet />
    </AppProviders>
  ) : (
    <Outlet />
  )
}

/** The two areas need the wallet and the other providers; the landing page does not. */
function isAppPath(pathname: string) {
  return [RoutePath.Lend, RoutePath.Borrow].some(
    area => pathname === area || pathname.startsWith(`${area}/`),
  )
}

// The Private page stands in for each area page until that page is built.
const standIn = (
  <WalletGate>
    <PrivatePage />
  </WalletGate>
)

const router = createBrowserRouter([
  {
    element: <ProvidersLayout />,
    errorElement: <ErrorBoundary />,
    children: [
      {
        path: RoutePath.Landing,
        element: <LandingPage />,
      },
      {
        path: RoutePath.Lend,
        element: <LenderLayout />,
        children: [
          { index: true, element: <Navigate to={RoutePath.LendProposals} replace /> },
          { path: RoutePath.LendProposals, element: standIn },
          { path: RoutePath.LendLoans, element: standIn },
          { path: RoutePath.LendTerms, element: standIn },
          { path: RoutePath.LendProfile, element: standIn },
        ],
      },
      {
        path: RoutePath.Borrow,
        element: <BorrowerLayout />,
        children: [
          { index: true, element: standIn },
          { path: RoutePath.BorrowLoans, element: standIn },
          { path: RoutePath.BorrowLender, element: standIn },
        ],
      },
      // The old single app: `/app` and its pages lead to the landing page and its two entrances.
      { path: '/app/*', element: <Navigate to={RoutePath.Landing} replace /> },
    ],
  },
])

export default function App() {
  return <RouterProvider router={router} />
}
