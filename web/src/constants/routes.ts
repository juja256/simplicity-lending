export const RoutePath = {
  Landing: '/',
  Dashboard: '/app',
  Private: '/app/private',
} as const

export type RoutePath = (typeof RoutePath)[keyof typeof RoutePath]
