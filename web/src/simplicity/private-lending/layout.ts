// The input and output indexes of the private lending transactions (the contracts' private
// lending core), and the NFT amounts. Pure: the scripts, the DOM-free flow builders and the Node
// e2e script share this one source.

/** One unit of a private NFT: its whole supply. */
export const NFT_AMOUNT = 1n
/** No reissuance token: the one unit issued is each NFT's whole supply. */
export const NO_REISSUANCE_TOKEN = 0n

/** The creation's outputs (`attach_creation`); change and fee follow. */
export const CREATION_OUTPUT = {
  borrowerNft: 0,
  lenderNft: 1,
  marker: 2,
  pendingOffer: 3,
} as const

/** The acceptance's covenant inputs (`attach_acceptance`); the lender's coins follow. */
export const ACCEPTANCE_INPUT = { offer: 0, lenderNft: 1 } as const

/** The acceptance's outputs (`attach_acceptance`); change and fee follow. */
export const ACCEPTANCE_OUTPUT = { activeOffer: 0, principal: 1, lenderNft: 2 } as const

/** The principal claim's inputs: the asset_auth output, then its NFT; fee coins follow. */
export const PRINCIPAL_CLAIM_INPUT = { principal: 0, borrowerNft: 1 } as const

/** The principal claim's outputs; change and fee follow. */
export const PRINCIPAL_CLAIM_OUTPUT = { borrowerNft: 0, principal: 1 } as const

/** The full repayment's inputs (`attach_full_repayment`); the borrower's coins follow. */
export const REPAYMENT_INPUT = { borrowerNft: 0, offer: 1 } as const

/**
 * The full repayment's outputs: the borrower NFT burned and the repayment at its asset_auth
 * (`attach_full_repayment`), then the collateral back to the borrower; change and fee follow.
 */
export const REPAYMENT_OUTPUT = { borrowerNftBurn: 0, repayment: 1, collateral: 2 } as const

/** The repayment claim's inputs: the asset_auth output, then its NFT; fee coins follow. */
export const REPAYMENT_CLAIM_INPUT = { repayment: 0, lenderNft: 1 } as const

/**
 * The repayment claim's outputs: the lender NFT burned, then the repayment; change and fee
 * follow.
 */
export const REPAYMENT_CLAIM_OUTPUT = { lenderNftBurn: 0, repayment: 1 } as const

/**
 * The cancellation's inputs (`attach_cancellation`): the pending offer, the lender NFT at its
 * script_auth lock, then the borrower NFT; fee coins follow.
 */
export const CANCELLATION_INPUT = { offer: 0, lenderNft: 1, borrowerNft: 2 } as const

/**
 * The cancellation's outputs: both NFTs burned (`attach_cancellation`), then the collateral back
 * to the borrower; change and fee follow.
 */
export const CANCELLATION_OUTPUT = { lenderNftBurn: 0, borrowerNftBurn: 1, collateral: 2 } as const

/** The liquidation's inputs (`attach_liquidation`): the active offer, then the lender NFT. */
export const LIQUIDATION_INPUT = { offer: 0, lenderNft: 1 } as const

/**
 * The liquidation's outputs: the lender NFT burned (`attach_liquidation`), then the collateral to
 * the lender; change and fee follow.
 */
export const LIQUIDATION_OUTPUT = { lenderNftBurn: 0, collateral: 1 } as const

/** Lock times from here on are timestamps, which a block height never reaches. */
export const LOCK_TIME_THRESHOLD = 500_000_000

/**
 * nSequence of the liquidated offer's input: 0xfffffffe (ENABLE_LOCKTIME_NO_RBF), as the
 * contracts' core sets it. Simplicity's `check_lock_height` reads the lock time as 0 when every
 * input is final (0xffffffff, LWK's default).
 */
export const LOCK_TIME_ENABLING_SEQUENCE = 0xfffffffe
