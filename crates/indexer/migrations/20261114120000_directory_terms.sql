-- The lender's terms, as LenderTerms::encode writes them, and when they were last published. Both
-- are null for entries written before the directory carried terms; such entries are not listed.
ALTER TABLE directory_entries ADD COLUMN terms BYTEA, ADD COLUMN terms_published_at timestamptz;
