-- An installment of a private loan: a repayment that leaves part of the debt, locked to the lender
-- NFT until the lender claims it. Postgres cannot use a new enum value in the transaction that adds
-- it, so this migration adds the value and nothing else.
ALTER TYPE private_utxo_type ADD VALUE 'installment';
