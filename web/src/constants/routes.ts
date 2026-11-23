// The site's routes. The route decides the area: `/lend` is the lender console and `/borrow` the
// borrower app; nothing remembers a role.
export const RoutePath = {
  Landing: '/',
  Lend: '/lend',
  LendProposals: '/lend/proposals',
  LendLoans: '/lend/loans',
  /** Redirects to the profile, which holds the terms. */
  LendTerms: '/lend/terms',
  LendProfile: '/lend/profile',
  Borrow: '/borrow',
  BorrowLender: '/borrow/:lenderKey',
  BorrowLoans: '/borrow/loans',
} as const

export type RoutePath = (typeof RoutePath)[keyof typeof RoutePath]

/** The proposal page for the lender with this x-only key. */
export function borrowLenderPath(pubkey: string): string {
  return `${RoutePath.Borrow}/${encodeURIComponent(pubkey)}`
}
