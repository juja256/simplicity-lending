use serde::{Deserialize, Serialize};

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize, utoipa::ToSchema,
)]
#[sqlx(type_name = "private_offer_status", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum PrivateOfferStatus {
    Pending,
    Active,
    Cancelled,
    Repaid,
    Liquidated,
}

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    PartialOrd,
    Eq,
    sqlx::Type,
    Serialize,
    Deserialize,
    utoipa::ToSchema,
)]
#[sqlx(type_name = "private_utxo_type", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum PrivateUtxoType {
    PendingOffer,
    ActiveOffer,
    Principal,
    Repayment,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PrivateOfferModel {
    pub id: i64,
    pub creation_txid: Vec<u8>,
    pub nonce: Vec<u8>,
    pub view_tag: i16,
    pub encrypted_lender_key: Vec<u8>,
    pub first_input_txid: Vec<u8>,
    pub first_input_vout: i64,
    pub borrower_nft_asset_id: Vec<u8>,
    pub lender_nft_asset_id: Vec<u8>,
    pub current_status: PrivateOfferStatus,
    pub created_at_height: i64,
    pub updated_at_height: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PrivateOfferUtxoModel {
    pub offer_id: i64,
    pub txid: Vec<u8>,
    pub vout: i32,
    pub utxo_type: PrivateUtxoType,
    pub created_at_height: i64,
    pub spent_txid: Option<Vec<u8>>,
    pub spent_at_height: Option<i64>,
}
