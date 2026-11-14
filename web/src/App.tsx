import { useEffect, useState } from 'react'
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
} from 'react-router-dom'

import AppLayout from '@/components/AppLayout'
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

function isAppPath(pathname: string) {
  return pathname === RoutePath.Dashboard || pathname.startsWith(`${RoutePath.Dashboard}/`)
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
        path: RoutePath.Dashboard,
        element: <AppLayout />,
        children: [
          {
            path: RoutePath.Private,
            element: <PrivatePage />,
          },
          // The private page is the app: `/app` and old links such as `/app/borrow` land on it.
          {
            index: true,
            element: <Navigate to={RoutePath.Private} replace />,
          },
          {
            path: '*',
            element: <Navigate to={RoutePath.Private} replace />,
          },
        ],
      },
    ],
  },
])

export default function App() {
  return <RouterProvider router={router} />
}
