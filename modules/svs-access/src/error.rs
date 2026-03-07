//! Access control module error types.

/// Errors that can occur during access control enforcement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessError {
    /// User is not on the whitelist.
    NotWhitelisted,
    /// User is on the blacklist.
    Blacklisted,
    /// User's account is frozen.
    AccountFrozen,
    /// Invalid merkle proof.
    InvalidProof,
    /// Merkle root is not set (required for whitelist/blacklist).
    MerkleRootNotSet,
}

impl core::fmt::Display for AccessError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            AccessError::NotWhitelisted => write!(f, "user is not on the whitelist"),
            AccessError::Blacklisted => write!(f, "user is on the blacklist"),
            AccessError::AccountFrozen => write!(f, "user's account is frozen"),
            AccessError::InvalidProof => write!(f, "invalid merkle proof"),
            AccessError::MerkleRootNotSet => write!(f, "merkle root is not set"),
        }
    }
}

impl std::error::Error for AccessError {}
