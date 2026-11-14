-- The indexer tracks private offers only, so the public lending tables and their types go.
DROP TABLE offer_participants, offer_utxos, offers, factory_auths, factory_utxos, factories;

DROP TYPE participant_type, utxo_type, offer_status, factory_status;
