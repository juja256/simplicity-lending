use sqlx::PgPool;

use lending_contracts::programs::{private_lending::PrivateLendingOffer, program::SimplexProgram};
use private_lending_core::find_offer;
use simplex::simplicityhl::elements::{
    AssetId, OutPoint, Transaction, confidential::Nonce, encode::serialize, hashes::Hash,
};

use crate::{
    db::DbTx,
    indexer::{
        cache::WatchCache,
        trackers::private_offers::{
            insert_private_offer, insert_private_offer_utxo, load_private_offer_utxos_cache,
        },
    },
    models::{PrivateOfferModel, PrivateOfferStatus, PrivateOfferUtxoModel, PrivateUtxoType},
};

/// The output of a creation transaction that holds the pending offer.
const OFFER_VOUT: u32 = 3;

#[derive(Debug, Clone, Copy)]
pub struct PrivateOfferWatchEntry {
    pub offer_id: i64,
    pub utxo_type: PrivateUtxoType,
    pub borrower_nft: AssetId,
    pub lender_nft: AssetId,
}

pub struct PrivateOffersTracker {
    cache: WatchCache<PrivateOfferWatchEntry>,
    program_id: [u8; 4],
}

impl PrivateOffersTracker {
    pub async fn load(db_pool: &PgPool) -> anyhow::Result<Self> {
        Ok(Self {
            cache: load_private_offer_utxos_cache(db_pool).await?,
            program_id: PrivateLendingOffer::get_program_id(),
        })
    }

    pub fn begin_block(&mut self) {
        self.cache.begin_block();
    }

    pub fn commit_block(&mut self) {
        self.cache.commit_block();
    }

    pub fn abort_block(&mut self) {
        self.cache.abort_block();
    }

    pub async fn process_tx(
        &mut self,
        sql_tx: &mut DbTx<'_>,
        tx: &Transaction,
        block_height: u64,
    ) -> anyhow::Result<()> {
        self.process_creation(sql_tx, tx, block_height).await
    }

    async fn process_creation(
        &mut self,
        sql_tx: &mut DbTx<'_>,
        tx: &Transaction,
        block_height: u64,
    ) -> anyhow::Result<()> {
        let Some(found) = find_offer(tx, self.program_id) else {
            return Ok(());
        };
        let Nonce::Confidential(nonce) = found.offer.nonce else {
            return Ok(());
        };

        let txid = tx.txid();
        let height = block_height as i64;
        let offer = PrivateOfferModel {
            id: 0,
            creation_txid: txid.to_byte_array().to_vec(),
            nonce: nonce.serialize().to_vec(),
            view_tag: i16::from(found.marker.view_tag),
            encrypted_lender_key: found.marker.encrypted_lender_key.to_vec(),
            first_input_txid: found.first_input.txid.to_byte_array().to_vec(),
            first_input_vout: i64::from(found.first_input.vout),
            borrower_nft_asset_id: found.borrower_nft.into_inner().0.to_vec(),
            lender_nft_asset_id: found.lender_nft.into_inner().0.to_vec(),
            current_status: PrivateOfferStatus::Pending,
            created_at_height: height,
            updated_at_height: height,
        };

        let Some(offer_id) = insert_private_offer(sql_tx, &offer, &serialize(tx)).await? else {
            return Ok(());
        };

        insert_private_offer_utxo(
            sql_tx,
            &PrivateOfferUtxoModel {
                offer_id,
                txid: offer.creation_txid.clone(),
                vout: OFFER_VOUT as i32,
                utxo_type: PrivateUtxoType::PendingOffer,
                created_at_height: height,
                spent_txid: None,
                spent_at_height: None,
            },
        )
        .await?;

        self.cache.insert(
            OutPoint {
                txid,
                vout: OFFER_VOUT,
            },
            PrivateOfferWatchEntry {
                offer_id,
                utxo_type: PrivateUtxoType::PendingOffer,
                borrower_nft: found.borrower_nft,
                lender_nft: found.lender_nft,
            },
        );

        tracing::info!(%offer_id, %txid, "Private offer indexed on creation");

        Ok(())
    }
}
