-- The challenge the last put consumed and the signature it carried, so anyone can check the entry
-- against the lender's key. Both are null for entries written before the directory kept them.
ALTER TABLE directory_entries ADD COLUMN signed_challenge BYTEA, ADD COLUMN signature BYTEA;
