import { useEffect, useState } from 'react'
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
} from 'react-router-dom'

import BorrowerLayout from '@/areas/borrow/BorrowerLayout'
import ChooseLenderPage from '@/areas/borrow/ChooseLenderPage'
import MyLoansPage from '@/areas/borrow/MyLoansPage'
import ProposalPage from '@/areas/borrow/ProposalPage'
import LenderLayout from '@/areas/lend/LenderLayout'
import LoanBookPage from '@/areas/lend/LoanBookPage'
import ProfilePage from '@/areas/lend/ProfilePage'
import ProposalsPage from '@/areas/lend/ProposalsPage'
import TermsPage from '@/areas/lend/TermsPage'
import { WalletGate } from '@/areas/WalletGate'
import { RoutePath } from '@/constants/routes'
import { AppProviders } from '@/providers/AppProviders'
import { initAnalytics, trackPageView } from '@/utils/analytics'

import ErrorBoundary from './components/ErrorBoundary'
import LandingPage from './pages/Landing'

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
          {
            path: RoutePath.LendProposals,
            element: (
              <WalletGate>
                <ProposalsPage />
              </WalletGate>
            ),
          },
          {
            path: RoutePath.LendLoans,
            element: (
              <WalletGate>
                <LoanBookPage />
              </WalletGate>
            ),
          },
          {
            path: RoutePath.LendTerms,
            element: (
              <WalletGate>
                <TermsPage />
              </WalletGate>
            ),
          },
          {
            path: RoutePath.LendProfile,
            element: (
              <WalletGate>
                <ProfilePage />
              </WalletGate>
            ),
          },
          // An unknown console path leads to the console's start.
          { path: '*', element: <Navigate to={RoutePath.LendProposals} replace /> },
        ],
      },
      {
        path: RoutePath.Borrow,
        element: <BorrowerLayout />,
        children: [
          {
            index: true,
            element: (
              <WalletGate>
                <ChooseLenderPage />
              </WalletGate>
            ),
          },
          {
            path: RoutePath.BorrowLoans,
            element: (
              <WalletGate>
                <MyLoansPage />
              </WalletGate>
            ),
          },
          {
            path: RoutePath.BorrowLender,
            element: (
              <WalletGate>
                <ProposalPage />
              </WalletGate>
            ),
          },
          // An unknown borrower path, such as `/borrow/x/y`, leads to the borrower app's start.
          { path: '*', element: <Navigate to={RoutePath.Borrow} replace /> },
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
