export const RoutePath = {
  Landing: '/',
  Dashboard: '/app',
  Borrow: '/app/borrow',
  Supply: '/app/supply',
  Private: '/app/private',
} as const

export type RoutePath = (typeof RoutePath)[keyof typeof RoutePath]
