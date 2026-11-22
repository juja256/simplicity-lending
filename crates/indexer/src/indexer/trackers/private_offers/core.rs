use sqlx::PgPool;

use lending_contracts::programs::{
    asset_auth::{AssetAuth, AssetAuthParameters},
    private_lending::PrivateLendingOffer,
    program::SimplexProgram,
};
use private_lending_core::find_offer;
use simplex::{
    provider::SimplicityNetwork,
    simplicityhl::elements::{
        AssetId, OutPoint, Script, Transaction, TxOut,
        confidential::{Asset, Nonce, Value},
        encode::serialize,
        hashes::Hash,
        opcodes::all::OP_RETURN,
    },
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
/// The output of a creation transaction that holds the whole carry supply.
const CREATION_CARRY_VOUT: u32 = 4;
/// The outputs of an installment that hold the new carries.
const INSTALLMENT_CARRY_VOUTS: [u32; 2] = [3, 4];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingSpend {
    Cancellation,
    Acceptance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActiveSpend {
    Installment,
    FullRepayment,
    Liquidation,
}

/// The input at which the borrower's branches (installment, full repayment)
/// spend the loan.
const BORROWER_LOAN_INPUT: usize = 1;
/// The input at which the liquidation spends the loan.
const LIQUIDATION_LOAN_INPUT: usize = 0;
/// The output of the full repayment that pays the lender.
const REPAYMENT_VOUT: usize = 1;
/// The output of an installment that pays the lender.
const INSTALLMENT_VOUT: usize = 2;

/// Whether `script` is a null-data script as the program's burn check reads it
/// (`jet::output_null_datum`, Simplicity's `parseNullData`): `OP_RETURN` followed only by pushes
/// (opcodes up to `OP_16`), each with all the bytes it pushes. `Script::is_op_return` tests the
/// first byte only.
fn is_null_data(script: &Script) -> bool {
    let bytes = script.as_bytes();
    if bytes.first() != Some(&OP_RETURN.into_u8()) {
        return false;
    }

    let mut at = 1;
    while at < bytes.len() {
        let code = bytes[at];
        at += 1;
        let width = match code {
            0x00..=0x4b => {
                at += usize::from(code);
                continue;
            }
            0x4c => 1,
            0x4d => 2,
            0x4e => 4,
            0x4f..=0x60 => continue,
            _ => return false,
        };
        let Some(length) = bytes.get(at..at + width) else {
            return false;
        };
        at += width;
        at += length
            .iter()
            .rev()
            .fold(0_usize, |length, byte| (length << 8) | usize::from(*byte));
    }

    at == bytes.len()
}

/// Whether output 0 holds one explicit unit of `nft`, at any script: what the program checks of
/// the NFT that passes from input 0 or 1 to output 0.
fn nft_first(tx: &Transaction, nft: AssetId) -> bool {
    tx.output.first().is_some_and(|out: &TxOut| {
        out.asset == Asset::Explicit(nft) && out.value == Value::Explicit(1)
    })
}

/// Whether output 0 burns `nft`: one explicit unit of it at a null-data script, as the program's
/// cancellation, full repayment and liquidation require.
fn burns_first(tx: &Transaction, nft: AssetId) -> bool {
    nft_first(tx, nft) && is_null_data(&tx.output[0].script_pubkey)
}

/// The script of the `asset_auth` lock of `nft` that the offer's program pins: the repayment's
/// (the lender NFT, burned), an installment's (the lender NFT, kept), or the carries' and the
/// principal's (the borrower NFT, kept). Its parameters are the NFT ids, which the indexer reads
/// from the creation's outputs 0 and 1 and which a verifying offer takes from its terms. A taproot
/// output's script does not depend on the network, only its address does, so any network gives
/// it.
fn asset_auth_script(nft: AssetId, with_asset_burn: bool) -> Script {
    AssetAuth::new(AssetAuthParameters {
        asset_id: nft,
        asset_amount: 1,
        with_asset_burn,
        network: SimplicityNetwork::LiquidTestnet,
    })
    .get_script_pubkey()
}

/// A cancellation burns the lender NFT in output 0; any other spend is an acceptance, whose output
/// 0 is the loan, confidential.
fn classify_pending_spend(tx: &Transaction, lender_nft: AssetId) -> PendingSpend {
    if burns_first(tx, lender_nft) {
        PendingSpend::Cancellation
    } else {
        PendingSpend::Acceptance
    }
}

/// Whether output `vout` exists and is at `script`.
fn output_at(tx: &Transaction, vout: usize, script: &Script) -> bool {
    tx.output
        .get(vout)
        .is_some_and(|out: &TxOut| out.script_pubkey == *script)
}

/// Reads a spend of the active offer at input `loan_input` from the scripts the contract's
/// branches pin, which the indexer sees without opening a commitment.
///
/// The borrower's branches spend the loan at input 1 and move the borrower NFT to output 0. The
/// full repayment pays the lender at output 1, at the repayment lock (the lender NFT's
/// `asset_auth` with burn), and burns the NFT. An installment puts the successor loan at output 1,
/// at the loan's own address, which cannot be that lock, the installment at output 2, at the
/// installment lock (the lender NFT's `asset_auth` without burn), and the new carries at outputs 3
/// and 4, at the carry lock (the borrower NFT's). The program does not check output 0's script in
/// an installment, so an installment may burn the NFT there: output 1 tells the two apart, and it
/// is read first, since the full repayment leaves its other outputs free. The liquidation spends
/// the loan at input 0 and burns the lender NFT in output 0. A spend that matches none of these
/// layouts gives `None`: no spend the program accepts makes it, so the indexer does not guess.
fn classify_active_spend(
    tx: &Transaction,
    loan_input: usize,
    borrower_nft: AssetId,
    lender_nft: AssetId,
) -> Option<ActiveSpend> {
    match loan_input {
        BORROWER_LOAN_INPUT if nft_first(tx, borrower_nft) => {
            if output_at(tx, REPAYMENT_VOUT, &asset_auth_script(lender_nft, true)) {
                return burns_first(tx, borrower_nft).then_some(ActiveSpend::FullRepayment);
            }
            let carry_lock = asset_auth_script(borrower_nft, false);
            let installment =
                output_at(tx, INSTALLMENT_VOUT, &asset_auth_script(lender_nft, false))
                    && INSTALLMENT_CARRY_VOUTS
                        .iter()
                        .all(|vout| output_at(tx, *vout as usize, &carry_lock));
            installment.then_some(ActiveSpend::Installment)
        }
        LIQUIDATION_LOAN_INPUT if burns_first(tx, lender_nft) => Some(ActiveSpend::Liquidation),
        _ => None,
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
        for (input_index, input) in tx.input.iter().enumerate() {
            let Some(entry) = self.cache.get(&input.previous_output).copied() else {
                continue;
            };
            self.on_spend(
                sql_tx,
                tx,
                input_index,
                &input.previous_output,
                entry,
                block_height,
            )
            .await?;
        }

        Ok(())
    }

    #[tracing::instrument(
        name = "Handling private offer UTXO spend",
        skip(self, sql_tx, tx, entry),
        fields(
            offer_id = %entry.offer_id,
            utxo_type = ?entry.utxo_type,
            block_height = %block_height
        )
    )]
    async fn on_spend(
        &mut self,
        sql_tx: &mut DbTx<'_>,
        tx: &Transaction,
        input_index: usize,
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
            PrivateUtxoType::ActiveOffer => {
                match classify_active_spend(tx, input_index, entry.borrower_nft, entry.lender_nft) {
                    // An installment changes no status: the loan stays active at output 1.
                    Some(ActiveSpend::Installment) => {
                        self.add_utxo(
                            sql_tx,
                            tx,
                            entry,
                            PrivateUtxoType::ActiveOffer,
                            1,
                            block_height,
                        )
                        .await?;
                        self.add_utxo(
                            sql_tx,
                            tx,
                            entry,
                            PrivateUtxoType::Installment,
                            2,
                            block_height,
                        )
                        .await?;
                        for vout in INSTALLMENT_CARRY_VOUTS {
                            self.add_utxo(
                                sql_tx,
                                tx,
                                entry,
                                PrivateUtxoType::Carry,
                                vout,
                                block_height,
                            )
                            .await?;
                        }
                        tracing::info!(%offer_id, %txid, "Private offer installment paid");
                    }
                    Some(ActiveSpend::FullRepayment) => {
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
                    Some(ActiveSpend::Liquidation) => {
                        update_private_offer_status(
                            sql_tx,
                            offer_id,
                            PrivateOfferStatus::Liquidated,
                            block_height,
                        )
                        .await?;
                        tracing::info!(%offer_id, %txid, "Private offer liquidated");
                    }
                    // The spend is recorded above, since it happened; the offer keeps its status.
                    None => {
                        tracing::warn!(
                            %offer_id,
                            %txid,
                            input_index,
                            "Active private offer spent in no branch's layout; status unchanged"
                        );
                    }
                }
            }
            // An installment, the full repayment or the cancellation spends the carries, and the
            // spend is recorded above. A liquidation leaves them unspent.
            PrivateUtxoType::Carry => {
                tracing::info!(%offer_id, %txid, "Private offer carry spent");
            }
            PrivateUtxoType::Principal
            | PrivateUtxoType::Repayment
            | PrivateUtxoType::Installment => {
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

        let entry = PrivateOfferWatchEntry {
            offer_id,
            utxo_type: PrivateUtxoType::PendingOffer,
            borrower_nft: found.borrower_nft,
            lender_nft: found.lender_nft,
        };
        for (vout, utxo_type) in [
            (OFFER_VOUT, PrivateUtxoType::PendingOffer),
            (CREATION_CARRY_VOUT, PrivateUtxoType::Carry),
        ] {
            // A creation without the carry output records the offer alone; the contract never
            // lets a real one lack it.
            if vout as usize >= tx.output.len() {
                continue;
            }
            insert_private_offer_utxo(
                sql_tx,
                &PrivateOfferUtxoModel {
                    offer_id,
                    txid: offer.creation_txid.clone(),
                    vout: vout as i32,
                    utxo_type,
                    created_at_height: height,
                    spent_txid: None,
                    spent_at_height: None,
                },
            )
            .await?;
            self.cache.insert(
                OutPoint { txid, vout },
                PrivateOfferWatchEntry { utxo_type, ..entry },
            );
        }

        tracing::info!(%offer_id, %txid, "Private offer indexed on creation");

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use simplex::simplicityhl::elements::LockTime;

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

    /// A spend of the active offer at input `loan_input`, with `outputs`.
    fn spend(loan_input: usize, outputs: Vec<TxOut>) -> (Transaction, usize) {
        (
            Transaction {
                output: outputs,
                ..tx(plain(asset(0)))
            },
            loan_input,
        )
    }

    fn classify((tx, loan_input): (Transaction, usize)) -> Option<ActiveSpend> {
        classify_active_spend(&tx, loan_input, asset(1), asset(2))
    }

    /// An output at `script`, of an asset the classification does not read.
    fn at(script: Script) -> TxOut {
        TxOut {
            script_pubkey: script,
            ..plain(asset(9))
        }
    }

    fn repayment_lock() -> TxOut {
        at(asset_auth_script(asset(2), true))
    }

    fn installment_lock() -> TxOut {
        at(asset_auth_script(asset(2), false))
    }

    fn carry_lock() -> TxOut {
        at(asset_auth_script(asset(1), false))
    }

    /// An installment's outputs after output 0: the successor (at a script of its own), the
    /// installment, the two carries and the release.
    fn installment_outputs(first: TxOut) -> Vec<TxOut> {
        vec![
            first,
            plain(asset(9)),
            installment_lock(),
            carry_lock(),
            carry_lock(),
            plain(asset(9)),
        ]
    }

    #[test]
    fn active_spend_holding_the_borrower_nft_is_an_installment() {
        assert_eq!(
            classify(spend(1, installment_outputs(plain(asset(1))))),
            Some(ActiveSpend::Installment)
        );
    }

    /// The program checks only the NFT's asset and amount at an installment's output 0, so an
    /// installment can burn it there; its outputs 1 to 4 still make it an installment.
    #[test]
    fn installment_burning_the_borrower_nft_is_an_installment() {
        assert_eq!(
            classify(spend(1, installment_outputs(burn(asset(1))))),
            Some(ActiveSpend::Installment)
        );
    }

    #[test]
    fn active_spend_paying_the_repayment_lock_is_a_full_repayment() {
        assert_eq!(
            classify(spend(
                1,
                vec![burn(asset(1)), repayment_lock(), plain(asset(9))]
            )),
            Some(ActiveSpend::FullRepayment)
        );
    }

    /// The full repayment leaves its outputs after 1 free: one that also has an installment's
    /// outputs 2 to 4 is still the full repayment.
    #[test]
    fn full_repayment_with_an_installment_s_later_outputs_is_a_full_repayment() {
        assert_eq!(
            classify(spend(
                1,
                vec![
                    burn(asset(1)),
                    repayment_lock(),
                    installment_lock(),
                    carry_lock(),
                    carry_lock(),
                ]
            )),
            Some(ActiveSpend::FullRepayment)
        );
    }

    #[test]
    fn active_spend_burning_the_lender_nft_is_a_liquidation() {
        assert_eq!(
            classify(spend(0, vec![burn(asset(2)), plain(asset(9))])),
            Some(ActiveSpend::Liquidation)
        );
    }

    #[test]
    fn active_spends_that_match_no_layout_are_refused() {
        let mut no_carries = installment_outputs(plain(asset(1)));
        no_carries.truncate(4);
        let mut foreign_carry = installment_outputs(plain(asset(1)));
        foreign_carry[4] = plain(asset(9));
        let mut foreign_installment = installment_outputs(plain(asset(1)));
        foreign_installment[2] = repayment_lock();
        let mut two_nfts = installment_outputs(plain(asset(1)));
        two_nfts[0].value = Value::Explicit(2);
        for (case, refused) in [
            ("no outputs", spend(1, vec![])),
            ("a burn without output 1", spend(1, vec![burn(asset(1))])),
            (
                "the repayment lock without the NFT burned",
                spend(1, vec![plain(asset(1)), repayment_lock()]),
            ),
            (
                "an installment without output 2",
                spend(1, vec![plain(asset(1)), plain(asset(9))]),
            ),
            ("an installment without its carries", spend(1, no_carries)),
            (
                "an installment with a carry elsewhere",
                spend(1, foreign_carry),
            ),
            (
                "an installment paid to another lock",
                spend(1, foreign_installment),
            ),
            ("two units of the borrower NFT", spend(1, two_nfts)),
            (
                "an installment with the loan at input 0",
                spend(0, installment_outputs(plain(asset(1)))),
            ),
            (
                "an installment with the loan at input 2",
                spend(2, installment_outputs(plain(asset(1)))),
            ),
            (
                "a full repayment with the loan at input 0",
                spend(0, vec![burn(asset(1)), repayment_lock()]),
            ),
            (
                "a liquidation with the loan at input 1",
                spend(1, vec![burn(asset(2)), plain(asset(9))]),
            ),
            (
                "the lender NFT unburned",
                spend(0, vec![plain(asset(2)), plain(asset(9))]),
            ),
            (
                "the lender NFT at an OP_RETURN that is not null data",
                spend(
                    0,
                    vec![at_script(asset(2), vec![0x6a, 0x61]), plain(asset(9))],
                ),
            ),
            (
                "another asset at output 0",
                spend(1, installment_outputs(plain(asset(3)))),
            ),
            (
                "another asset burned",
                spend(0, vec![burn(asset(3)), plain(asset(9))]),
            ),
        ] {
            assert_eq!(classify(refused), None, "{case}");
        }
    }

    /// One unit of `asset` at the script of `bytes`.
    fn at_script(asset: AssetId, bytes: Vec<u8>) -> TxOut {
        TxOut {
            script_pubkey: Script::from(bytes),
            ..plain(asset)
        }
    }

    #[test]
    fn null_data_is_what_the_program_s_burn_check_accepts() {
        for (case, bytes, null_data) in [
            ("a bare OP_RETURN", vec![0x6a], true),
            ("a direct push", vec![0x6a, 0x02, 0xaa, 0xbb], true),
            ("an empty push", vec![0x6a, 0x00], true),
            ("OP_PUSHDATA1", vec![0x6a, 0x4c, 0x01, 0xaa], true),
            ("OP_PUSHDATA2", vec![0x6a, 0x4d, 0x01, 0x00, 0xaa], true),
            (
                "OP_PUSHDATA4",
                vec![0x6a, 0x4e, 0x01, 0x00, 0x00, 0x00, 0xaa],
                true,
            ),
            (
                "OP_1NEGATE, OP_RESERVED, OP_1 and OP_16",
                vec![0x6a, 0x4f, 0x50, 0x51, 0x60],
                true,
            ),
            (
                "pushes",
                [vec![0x6a], [0x01, 0xaa].repeat(3)].concat(),
                true,
            ),
            ("an empty script", vec![], false),
            ("no OP_RETURN first", vec![0x51, 0x6a], false),
            ("OP_NOP after the OP_RETURN", vec![0x6a, 0x61], false),
            ("a second OP_RETURN", vec![0x6a, 0x6a], false),
            ("a truncated push", vec![0x6a, 0x02, 0xaa], false),
            ("a truncated OP_PUSHDATA1", vec![0x6a, 0x4c], false),
            (
                "a truncated OP_PUSHDATA2 length",
                vec![0x6a, 0x4d, 0x01],
                false,
            ),
            (
                "a truncated OP_PUSHDATA4 push",
                vec![0x6a, 0x4e, 0x02, 0, 0, 0, 0xaa],
                false,
            ),
        ] {
            assert_eq!(is_null_data(&Script::from(bytes)), null_data, "{case}");
        }
        assert!(is_null_data(&Script::new_op_return(b"burn")));
    }

    /// The locks are taproot outputs, whose script does not depend on the network.
    #[test]
    fn asset_auth_scripts_do_not_depend_on_the_network() {
        for network in [
            SimplicityNetwork::Liquid,
            SimplicityNetwork::LiquidTestnet,
            SimplicityNetwork::default_regtest(),
        ] {
            for with_asset_burn in [false, true] {
                let lock = AssetAuth::new(AssetAuthParameters {
                    asset_id: asset(2),
                    asset_amount: 1,
                    with_asset_burn,
                    network,
                });
                assert_eq!(
                    lock.get_script_pubkey(),
                    asset_auth_script(asset(2), with_asset_burn),
                );
            }
        }
        assert_ne!(
            asset_auth_script(asset(2), true),
            asset_auth_script(asset(2), false)
        );
    }
}
