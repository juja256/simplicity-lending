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
