// The input and output indexes of the private lending transactions (the contracts' private
// lending core), and the NFT amounts. Pure: the scripts, the DOM-free flow builders and the Node
// e2e script share this one source.

/** One unit of a private NFT: its whole supply. */
export const NFT_AMOUNT = 1n
/** No reissuance token: the one unit issued is each NFT's whole supply. */
export const NO_REISSUANCE_TOKEN = 0n

/**
 * The carry token's supply, `S = 2^50` units, which the creation issues for the loan at its input
 * 2 and holds, explicit, at its output 4 (the wasm's `carrySupply()`).
 */
export const CARRY_SUPPLY = 1n << 50n

/**
 * The creation's inputs (`attach_creation`): input 0 issues the borrower NFT, input 1 the lender
 * NFT, and input 2, the first collateral coin, the carry token; the other collateral coins follow.
 */
export const CREATION_INPUT = {
  borrowerNftIssuance: 0,
  lenderNftIssuance: 1,
  carryIssuance: 2,
} as const

/**
 * The creation's outputs (`attach_creation`): the NFTs, the marker, the pending offer, then the
 * carry supply, explicit at the principal's asset_auth (borrower NFT, no burn); change and fee
 * follow.
 */
export const CREATION_OUTPUT = {
  borrowerNft: 0,
  lenderNft: 1,
  marker: 2,
  pendingOffer: 3,
  carrySupply: 4,
} as const

/** The acceptance's covenant inputs (`attach_acceptance`); the lender's coins follow. */
export const ACCEPTANCE_INPUT = { offer: 0, lenderNft: 1 } as const

/** The acceptance's outputs (`attach_acceptance`); change and fee follow. */
export const ACCEPTANCE_OUTPUT = { activeOffer: 0, principal: 1, lenderNft: 2 } as const

/** The principal claim's inputs: the asset_auth output, then its NFT; fee coins follow. */
export const PRINCIPAL_CLAIM_INPUT = { principal: 0, borrowerNft: 1 } as const

/** The principal claim's outputs; change and fee follow. */
export const PRINCIPAL_CLAIM_OUTPUT = { borrowerNft: 0, principal: 1 } as const

/**
 * The most installments a loan has: the release proof's tree of blinder commitments has 1024
 * leaves, so the contract refuses an installment at step 1024, where only the full repayment is
 * left.
 */
export const MAX_LOAN_INSTALLMENTS = 1024

/**
 * The installment's inputs (`attach_installment`): the borrower NFT and the loan, then the
 * borrower's principal coins, then the loan's carries, then its fee coins. The installment's key
 * derives from the first wallet coin, input 2, the first principal coin: never a carry, which
 * every build at one step spends (proofs, O11).
 */
export const INSTALLMENT_INPUT = { borrowerNft: 0, loan: 1, firstWalletCoin: 2 } as const

/**
 * The installment's outputs (`attach_installment`): the borrower NFT back to the borrower,
 * explicit, the successor loan, the installment at its asset_auth (lender NFT, no burn), and the
 * carries `W1` and `W2` at the principal's asset_auth (borrower NFT, no burn). Output 5 is the
 * collateral released to the borrower, or, when nothing is released, one more confidential
 * output to the borrower, so that the count does not tell (proofs, R2). At the first installment
 * output 6 burns the carry supply's leftover. The principal change follows if any, then the
 * policy-asset change and the fee.
 */
export const INSTALLMENT_OUTPUT = {
  borrowerNft: 0,
  loan: 1,
  installment: 2,
  carry: 3,
  secondCarry: 4,
  release: 5,
  leftoverBurn: 6,
} as const

/** The full repayment's inputs (`attach_full_repayment`); the borrower's coins follow. */
export const REPAYMENT_INPUT = { borrowerNft: 0, offer: 1 } as const

/**
 * The full repayment's outputs: the borrower NFT burned and the repayment at its asset_auth
 * (`attach_full_repayment`), the collateral back to the borrower, then the confidential burn of
 * every carry unit (`attach_carry_sweep`); change and fee follow.
 */
export const REPAYMENT_OUTPUT = {
  borrowerNftBurn: 0,
  repayment: 1,
  collateral: 2,
  carryBurn: 3,
} as const

/**
 * The lender's claims' inputs: the lender NFT, then the locked outputs it unlocks, from input 1:
 * installments (asset_auth(lender NFT, 1, no burn)), and at the final claim the full repayment
 * after them (asset_auth(lender NFT, 1, burn)); fee coins follow.
 */
export const CLAIM_INPUT = { lenderNft: 0, firstLocked: 1 } as const

/**
 * The lender's claims' outputs: the lender NFT, back to the lender, explicit, or burned at the
 * final claim, then what was claimed, to the lender; change and fee follow.
 */
export const CLAIM_OUTPUT = { lenderNft: 0, claimed: 1 } as const

/**
 * The cancellation's inputs (`attach_cancellation`): the pending offer, the lender NFT at its
 * script_auth lock, the borrower NFT, then the carry supply (the creation's output 4, unlocked by
 * the borrower NFT); fee coins follow.
 */
export const CANCELLATION_INPUT = {
  offer: 0,
  lenderNft: 1,
  borrowerNft: 2,
  carrySupply: 3,
} as const

/**
 * The cancellation's outputs: both NFTs and the carry supply burned (`attach_cancellation`, the
 * supply explicit: it is the same for every loan), then the collateral back to the borrower;
 * change and fee follow.
 */
export const CANCELLATION_OUTPUT = {
  lenderNftBurn: 0,
  borrowerNftBurn: 1,
  carryBurn: 2,
  collateral: 3,
} as const

/**
 * The liquidation's inputs (`attach_liquidation`): the loan, then the lender NFT, then from input
 * 2 the unclaimed installments that open for the lender; fee coins follow.
 */
export const LIQUIDATION_INPUT = { offer: 0, lenderNft: 1, firstInstallment: 2 } as const

/**
 * The liquidation's outputs: the lender NFT burned (`attach_liquidation`), the collateral to the
 * lender, then the installments' sum to the lender when it sweeps any; change and fee follow.
 */
export const LIQUIDATION_OUTPUT = { lenderNftBurn: 0, collateral: 1, installments: 2 } as const

/** Lock times from here on are timestamps, which a block height never reaches. */
export const LOCK_TIME_THRESHOLD = 500_000_000

/**
 * nSequence of the liquidated offer's input: 0xfffffffe (ENABLE_LOCKTIME_NO_RBF), as the
 * contracts' core sets it. Simplicity's `check_lock_height` reads the lock time as 0 when every
 * input is final (0xffffffff, LWK's default).
 */
export const LOCK_TIME_ENABLING_SEQUENCE = 0xfffffffe
