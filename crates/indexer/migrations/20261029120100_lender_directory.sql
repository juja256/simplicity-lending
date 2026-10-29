CREATE TABLE directory_entries (
    pubkey BYTEA PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE directory_challenges (
    challenge BYTEA PRIMARY KEY,
    expires_at timestamptz NOT NULL
);

CREATE INDEX directory_challenges_expires_at_idx ON directory_challenges (expires_at);
