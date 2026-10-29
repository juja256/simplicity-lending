use sqlx::PgPool;

use lending_contracts::programs::{private_lending::PrivateLendingOffer, program::SimplexProgram};
use private_lending_core::find_offer;
use simplex::simplicityhl::elements::{
    AssetId, OutPoint, Transaction, TxOut,
    confidential::{Asset, Nonce},
    encode::serialize,
    hashes::Hash,
};

use crate::{
    db::DbTx,
    indexer::{
        cache::WatchCache,
        trackers::private_offers::{
            insert_private_offer, insert_private_offer_utxo, load_private_offer_utxos_cache,
            spend_private_offer_utxo, update_private_offer_status,
        },
    },
    models::{PrivateOfferModel, PrivateOfferStatus, PrivateOfferUtxoModel, PrivateUtxoType},
};

/// The output of a creation transaction that holds the pending offer.
const OFFER_VOUT: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingSpend {
    Cancellation,
    Acceptance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActiveSpend {
    Repayment,
    Liquidation,
}

/// Whether output 0 burns `nft`: an `OP_RETURN` output with that explicit asset.
fn burns_first(tx: &Transaction, nft: AssetId) -> bool {
    tx.output.first().is_some_and(|out: &TxOut| {
        out.script_pubkey.is_op_return() && out.asset == Asset::Explicit(nft)
    })
}

/// A cancellation burns the lender NFT in output 0; any other spend is an acceptance.
fn classify_pending_spend(tx: &Transaction, lender_nft: AssetId) -> PendingSpend {
    if burns_first(tx, lender_nft) {
        PendingSpend::Cancellation
    } else {
        PendingSpend::Acceptance
    }
}

/// A repayment burns the borrower NFT in output 0; any other spend is a liquidation.
fn classify_active_spend(tx: &Transaction, borrower_nft: AssetId) -> ActiveSpend {
    if burns_first(tx, borrower_nft) {
        ActiveSpend::Repayment
    } else {
        ActiveSpend::Liquidation
    }
}

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
        self.process_spends(sql_tx, tx, block_height).await?;
        self.process_creation(sql_tx, tx, block_height).await
    }

    async fn process_spends(
        &mut self,
        sql_tx: &mut DbTx<'_>,
        tx: &Transaction,
        block_height: u64,
    ) -> anyhow::Result<()> {
        for input in &tx.input {
            let Some(entry) = self.cache.get(&input.previous_output).copied() else {
                continue;
            };
            self.on_spend(sql_tx, tx, &input.previous_output, entry, block_height)
                .await?;
        }

        Ok(())
    }

    #[tracing::instrument(
        name = "Handling private offer UTXO spend",
        skip(self, sql_tx, tx, entry),
        fields(offer_id = %entry.offer_id, utxo_type = ?entry.utxo_type, block_height = %block_height)
    )]
    async fn on_spend(
        &mut self,
        sql_tx: &mut DbTx<'_>,
        tx: &Transaction,
        old_outpoint: &OutPoint,
        entry: PrivateOfferWatchEntry,
        block_height: u64,
    ) -> anyhow::Result<()> {
        let txid = tx.txid();
        let offer_id = entry.offer_id;

        spend_private_offer_utxo(sql_tx, old_outpoint, block_height, txid).await?;
        self.cache.remove(old_outpoint);

        match entry.utxo_type {
            PrivateUtxoType::PendingOffer => match classify_pending_spend(tx, entry.lender_nft) {
                PendingSpend::Cancellation => {
                    update_private_offer_status(
                        sql_tx,
                        offer_id,
                        PrivateOfferStatus::Cancelled,
                        block_height,
                    )
                    .await?;
                    tracing::info!(%offer_id, %txid, "Private offer cancelled");
                }
                PendingSpend::Acceptance => {
                    update_private_offer_status(
                        sql_tx,
                        offer_id,
                        PrivateOfferStatus::Active,
                        block_height,
                    )
                    .await?;
                    self.add_utxo(
                        sql_tx,
                        tx,
                        entry,
                        PrivateUtxoType::ActiveOffer,
                        0,
                        block_height,
                    )
                    .await?;
                    self.add_utxo(
                        sql_tx,
                        tx,
                        entry,
                        PrivateUtxoType::Principal,
                        1,
                        block_height,
                    )
                    .await?;
                    tracing::info!(%offer_id, %txid, "Private offer accepted");
                }
            },
            PrivateUtxoType::ActiveOffer => match classify_active_spend(tx, entry.borrower_nft) {
                ActiveSpend::Repayment => {
                    update_private_offer_status(
                        sql_tx,
                        offer_id,
                        PrivateOfferStatus::Repaid,
                        block_height,
                    )
                    .await?;
                    self.add_utxo(
                        sql_tx,
                        tx,
                        entry,
                        PrivateUtxoType::Repayment,
                        1,
                        block_height,
                    )
                    .await?;
                    tracing::info!(%offer_id, %txid, "Private offer repaid");
                }
                ActiveSpend::Liquidation => {
                    update_private_offer_status(
                        sql_tx,
                        offer_id,
                        PrivateOfferStatus::Liquidated,
                        block_height,
                    )
                    .await?;
                    tracing::info!(%offer_id, %txid, "Private offer liquidated");
                }
            },
            PrivateUtxoType::Principal | PrivateUtxoType::Repayment => {
                tracing::info!(%offer_id, %txid, "Private offer payout claimed");
            }
        }

        Ok(())
    }

    /// Records a new UTXO of the offer created by `txid` and starts watching it.
    ///
    /// The indexer never verifies candidates, so transitions must tolerate hostile
    /// transactions. One transaction can spend several tracked UTXOs whose transitions create
    /// the same outpoint: the first spend owns it, and a later one adds nothing. An output the
    /// transaction lacks is not recorded either.
    async fn add_utxo(
        &mut self,
        sql_tx: &mut DbTx<'_>,
        tx: &Transaction,
        entry: PrivateOfferWatchEntry,
        utxo_type: PrivateUtxoType,
        vout: u32,
        block_height: u64,
    ) -> anyhow::Result<()> {
        let txid = tx.txid();
        if vout as usize >= tx.output.len() {
            return Ok(());
        }
        let inserted = insert_private_offer_utxo(
            sql_tx,
            &PrivateOfferUtxoModel {
                offer_id: entry.offer_id,
                txid: txid.to_byte_array().to_vec(),
                vout: vout as i32,
                utxo_type,
                created_at_height: block_height as i64,
                spent_txid: None,
                spent_at_height: None,
            },
        )
        .await?;
        if inserted {
            self.cache.insert(
                OutPoint { txid, vout },
                PrivateOfferWatchEntry { utxo_type, ..entry },
            );
        }

        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use simplex::simplicityhl::elements::{
        LockTime, Script, TxOut,
        confidential::{Asset, Value},
    };

    fn asset(byte: u8) -> AssetId {
        AssetId::from_slice(&[byte; 32]).expect("valid asset id")
    }

    fn burn(asset: AssetId) -> TxOut {
        TxOut {
            asset: Asset::Explicit(asset),
            value: Value::Explicit(1),
            script_pubkey: Script::new_op_return(b"burn"),
            ..Default::default()
        }
    }

    fn plain(asset: AssetId) -> TxOut {
        TxOut {
            asset: Asset::Explicit(asset),
            value: Value::Explicit(1),
            script_pubkey: Script::from(vec![0x51_u8]),
            ..Default::default()
        }
    }

    fn tx(first_output: TxOut) -> Transaction {
        Transaction {
            version: 2,
            lock_time: LockTime::ZERO,
            input: vec![],
            output: vec![first_output],
        }
    }

    #[test]
    fn pending_spend_burning_the_lender_nft_is_a_cancellation() {
        assert_eq!(
            classify_pending_spend(&tx(burn(asset(2))), asset(2)),
            PendingSpend::Cancellation
        );
    }

    #[test]
    fn other_pending_spends_are_acceptances() {
        assert_eq!(
            classify_pending_spend(&tx(plain(asset(2))), asset(2)),
            PendingSpend::Acceptance
        );
        assert_eq!(
            classify_pending_spend(&tx(burn(asset(1))), asset(2)),
            PendingSpend::Acceptance
        );
    }

    #[test]
    fn active_spend_burning_the_borrower_nft_is_a_repayment() {
        assert_eq!(
            classify_active_spend(&tx(burn(asset(1))), asset(1)),
            ActiveSpend::Repayment
        );
    }

    #[test]
    fn other_active_spends_are_liquidations() {
        assert_eq!(
            classify_active_spend(&tx(burn(asset(2))), asset(1)),
            ActiveSpend::Liquidation
        );
        assert_eq!(
            classify_active_spend(&tx(plain(asset(1))), asset(1)),
            ActiveSpend::Liquidation
        );
    }
}
