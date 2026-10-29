use serde::Serialize;
use utoipa::ToSchema;

use crate::api::utils::format_hex;
use crate::models::{
    PrivateOfferModel, PrivateOfferStatus, PrivateOfferUtxoModel, PrivateUtxoType,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct OutPointDto {
    /// Transaction id, display-order hex.
    pub txid: String,
    pub vout: u32,
}

/// Everything a client needs to recognize its own offer without fetching the transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct PrivateCandidate {
    /// Creation transaction id, display-order hex. The offer is output 3 of this transaction.
    pub creation_txid: String,
    /// 33-byte compressed public key from output 3's nonce, hex.
    pub nonce: String,
    pub view_tag: u8,
    /// 32 bytes, hex.
    pub encrypted_lender_key: String,
    pub first_input: OutPointDto,
    /// Asset id, display-order hex.
    pub borrower_nft_asset_id: String,
    /// Asset id, display-order hex.
    pub lender_nft_asset_id: String,
    pub status: PrivateOfferStatus,
    pub created_at_height: u64,
    pub updated_at_height: u64,
}

impl From<PrivateOfferModel> for PrivateCandidate {
    fn from(model: PrivateOfferModel) -> Self {
        Self {
            creation_txid: format_hex(model.creation_txid),
            nonce: hex::encode(model.nonce),
            view_tag: model.view_tag as u8,
            encrypted_lender_key: hex::encode(model.encrypted_lender_key),
            first_input: OutPointDto {
                txid: format_hex(model.first_input_txid),
                vout: model.first_input_vout as u32,
            },
            borrower_nft_asset_id: format_hex(model.borrower_nft_asset_id),
            lender_nft_asset_id: format_hex(model.lender_nft_asset_id),
            status: model.current_status,
            created_at_height: model.created_at_height as u64,
            updated_at_height: model.updated_at_height as u64,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct PrivateCandidateList {
    pub items: Vec<PrivateCandidate>,
    /// Candidates in the requested range, ignoring `limit` and `offset`.
    pub total: u64,
    pub limit: u64,
    pub offset: u64,
    /// Height the indexer had reached when the list was read; `null` before the first block.
    pub last_indexed_height: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct PrivateUtxoDto {
    pub utxo_type: PrivateUtxoType,
    /// Transaction id, display-order hex.
    pub txid: String,
    pub vout: u32,
    pub created_at_height: u64,
    pub spent_txid: Option<String>,
    pub spent_at_height: Option<u64>,
}

impl From<PrivateOfferUtxoModel> for PrivateUtxoDto {
    fn from(model: PrivateOfferUtxoModel) -> Self {
        Self {
            utxo_type: model.utxo_type,
            txid: format_hex(model.txid),
            vout: model.vout as u32,
            created_at_height: model.created_at_height as u64,
            spent_txid: model.spent_txid.map(format_hex),
            spent_at_height: model.spent_at_height.map(|h| h as u64),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct PrivateCandidateDetails {
    #[serde(flatten)]
    pub candidate: PrivateCandidate,
    /// Ordered by creation height, then output index.
    pub utxos: Vec<PrivateUtxoDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct PrivateCreationTx {
    /// Consensus-encoded creation transaction, hex.
    pub tx_hex: String,
}
