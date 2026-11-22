-- A carry of a private loan: one of the outputs that hold the loan's carry token. Creation's output
-- 4 holds the whole supply, and each installment's outputs 3 and 4 hold the new carries. Postgres
-- cannot use a new enum value in the transaction that adds it, so this migration adds the value and
-- nothing else.
ALTER TYPE private_utxo_type ADD VALUE 'carry';
