use sqlx::PgPool;

use simplex::simplicityhl::elements::{Transaction, hex::ToHex};

use crate::{db::DbTx, indexer::PrivateOffersTracker};

pub struct TrackerRegistry {
    private_offers: PrivateOffersTracker,
}

impl TrackerRegistry {
    pub async fn load(db_pool: &PgPool) -> anyhow::Result<Self> {
        Ok(Self {
            private_offers: PrivateOffersTracker::load(db_pool).await?,
        })
    }

    pub fn begin_block(&mut self) {
        self.private_offers.begin_block();
    }

    pub fn commit_block(&mut self) {
        self.private_offers.commit_block();
    }

    pub fn abort_block(&mut self) {
        self.private_offers.abort_block();
    }

    #[tracing::instrument(
        name = "Processing utxo tracking",
        skip(self, sql_tx, tx, block_height),
        fields(txid = %tx.txid().to_hex())
    )]
    pub async fn process_tx(
        &mut self,
        sql_tx: &mut DbTx<'_>,
        tx: &Transaction,
        block_height: u64,
    ) -> anyhow::Result<()> {
        self.private_offers
            .process_tx(sql_tx, tx, block_height)
            .await
    }
}
