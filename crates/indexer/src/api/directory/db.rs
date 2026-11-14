use private_lending_core::LenderTerms;
use sqlx::{FromRow, PgPool, Postgres, Transaction};

use super::dto::{DirectoryChallenge, DirectoryEntry, DirectoryList, LenderTermsDto};

const CHALLENGE_LIFETIME_SECS: i32 = 300;

const ENTRY_COLUMNS: &str = r#"
    pubkey,
    display_name,
    terms,
    FLOOR(EXTRACT(EPOCH FROM terms_published_at))::BIGINT AS terms_published_at,
    signed_challenge,
    signature,
    FLOOR(EXTRACT(EPOCH FROM created_at))::BIGINT AS created_at,
    FLOOR(EXTRACT(EPOCH FROM updated_at))::BIGINT AS updated_at
"#;

#[derive(FromRow)]
struct EntryRow {
    pubkey: Vec<u8>,
    display_name: String,
    terms: Option<Vec<u8>>,
    terms_published_at: Option<i64>,
    signed_challenge: Option<Vec<u8>>,
    signature: Option<Vec<u8>>,
    created_at: i64,
    updated_at: i64,
}

impl From<EntryRow> for DirectoryEntry {
    /// Stored terms that do not decode are logged and served as no terms, so one bad row does not
    /// fail the whole list.
    fn from(row: EntryRow) -> Self {
        let pubkey = hex::encode(row.pubkey);
        let terms = row
            .terms
            .and_then(|bytes| match LenderTerms::decode(&bytes) {
                Ok(terms) => Some(LenderTermsDto::from(&terms)),
                Err(error) => {
                    tracing::error!(%pubkey, %error, "stored lender terms do not decode");
                    None
                }
            });
        DirectoryEntry {
            terms_published_at: terms.as_ref().and(row.terms_published_at),
            pubkey,
            display_name: row.display_name,
            terms,
            signed_challenge: row.signed_challenge.map(hex::encode),
            signature: row.signature.map(hex::encode),
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[tracing::instrument(name = "Issuing directory challenge", skip(db))]
pub async fn issue_challenge(db: &PgPool) -> Result<DirectoryChallenge, sqlx::Error> {
    let challenge: [u8; 32] = rand::random();
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM directory_challenges WHERE expires_at <= now()")
        .execute(&mut *tx)
        .await?;
    let expires_at = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO directory_challenges (challenge, expires_at)
        VALUES ($1, now() + make_interval(secs => $2))
        RETURNING FLOOR(EXTRACT(EPOCH FROM expires_at))::BIGINT
        "#,
    )
    .bind(challenge.as_slice())
    .bind(f64::from(CHALLENGE_LIFETIME_SECS))
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(DirectoryChallenge {
        challenge: hex::encode(challenge),
        expires_at,
    })
}

/// Lists the entries with terms; an entry written before the directory carried terms is left out.
#[tracing::instrument(name = "Listing directory entries", skip(db))]
pub async fn list_entries(
    db: &PgPool,
    limit: u64,
    offset: u64,
) -> Result<DirectoryList, sqlx::Error> {
    let total = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM directory_entries WHERE terms IS NOT NULL",
    )
    .fetch_one(db)
    .await?;
    let rows = sqlx::query_as::<_, EntryRow>(&format!(
        r#"
        SELECT {ENTRY_COLUMNS} FROM directory_entries
        WHERE terms IS NOT NULL
        ORDER BY display_name, pubkey
        LIMIT $1 OFFSET $2
        "#
    ))
    .bind(limit as i64)
    .bind(i64::try_from(offset).unwrap_or(i64::MAX))
    .fetch_all(db)
    .await?;

    Ok(DirectoryList {
        items: rows.into_iter().map(DirectoryEntry::from).collect(),
        total: total as u64,
        limit,
        offset,
    })
}

/// Fetches an entry, with or without terms.
#[tracing::instrument(name = "Fetching directory entry", skip(db, pubkey))]
pub async fn fetch_entry(
    db: &PgPool,
    pubkey: &[u8],
) -> Result<Option<DirectoryEntry>, sqlx::Error> {
    let row = sqlx::query_as::<_, EntryRow>(&format!(
        "SELECT {ENTRY_COLUMNS} FROM directory_entries WHERE pubkey = $1"
    ))
    .bind(pubkey)
    .fetch_optional(db)
    .await?;
    Ok(row.map(DirectoryEntry::from))
}

/// Consumes a live challenge. Returns `false` when it is unknown, used or expired.
pub async fn consume_challenge(
    tx: &mut Transaction<'_, Postgres>,
    challenge: &[u8],
) -> Result<bool, sqlx::Error> {
    let row = sqlx::query_scalar::<_, Vec<u8>>(
        "DELETE FROM directory_challenges WHERE challenge = $1 AND expires_at > now() RETURNING challenge",
    )
    .bind(challenge)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.is_some())
}

/// What a put writes: the name, the terms' encoding, and the challenge and signature that
/// authorized them.
pub struct EntryPut<'a> {
    pub display_name: &'a str,
    pub terms: &'a [u8],
    pub signed_challenge: &'a [u8],
    pub signature: &'a [u8],
}

/// Creates or replaces the entry with the put, published now. An entry without terms gains them
/// and is listed from then on.
pub async fn upsert_entry(
    tx: &mut Transaction<'_, Postgres>,
    pubkey: &[u8],
    put: EntryPut<'_>,
) -> Result<DirectoryEntry, sqlx::Error> {
    let row = sqlx::query_as::<_, EntryRow>(&format!(
        r#"
        INSERT INTO directory_entries
            (pubkey, display_name, terms, terms_published_at, signed_challenge, signature)
        VALUES ($1, $2, $3, now(), $4, $5)
        ON CONFLICT (pubkey) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            terms = EXCLUDED.terms,
            terms_published_at = EXCLUDED.terms_published_at,
            signed_challenge = EXCLUDED.signed_challenge,
            signature = EXCLUDED.signature,
            updated_at = now()
        RETURNING {ENTRY_COLUMNS}
        "#
    ))
    .bind(pubkey)
    .bind(put.display_name)
    .bind(put.terms)
    .bind(put.signed_challenge)
    .bind(put.signature)
    .fetch_one(&mut **tx)
    .await?;
    Ok(row.into())
}

/// Returns `false` when there was no entry to delete.
pub async fn delete_entry(
    tx: &mut Transaction<'_, Postgres>,
    pubkey: &[u8],
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query("DELETE FROM directory_entries WHERE pubkey = $1")
        .bind(pubkey)
        .execute(&mut **tx)
        .await?;
    Ok(result.rows_affected() > 0)
}
