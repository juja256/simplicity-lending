use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct DirectoryChallenge {
    /// 32 random bytes, hex. Single-use.
    pub challenge: String,
    /// Unix seconds.
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct DirectoryEntry {
    /// X-only lending key, 32 bytes, hex.
    pub pubkey: String,
    pub display_name: String,
    /// Unix seconds.
    pub created_at: i64,
    /// Unix seconds.
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct DirectoryList {
    pub items: Vec<DirectoryEntry>,
    /// Entries in the directory, ignoring paging.
    pub total: u64,
    pub limit: u64,
    pub offset: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PutDirectoryEntry {
    /// 1 to 64 characters, no leading or trailing whitespace, no control characters.
    pub display_name: String,
    /// A challenge issued by `POST /private/directory/challenges`, 32 bytes, hex.
    pub challenge: String,
    /// BIP340 signature, 64 bytes, hex.
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct DeleteDirectoryEntry {
    /// A challenge issued by `POST /private/directory/challenges`, 32 bytes, hex.
    pub challenge: String,
    /// BIP340 signature, 64 bytes, hex.
    pub signature: String,
}
