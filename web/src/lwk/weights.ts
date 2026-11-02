// Input weights free of app imports, so the DOM-free private flow builders can use them.

// ExternalUtxo max-weight-to-satisfy for an explicit-address UTXO spent with a plain
// p2wpkh/p2tr signature (no Simplicity covenant) — e.g. NFT references like FactoryAuth,
// Borrower NFT, or a pre-acceptance Lender NFT. Measured from several real broadcast txs
// (sig + pubkey = 104-105 bytes), plus margin.
export const EXPLICIT_SIGNATURE_MAX_WEIGHT_TO_SATISFY = 150
