//! Request and response types for the SVS Proof Backend

use serde::{Deserialize, Serialize};

/// Request for PubkeyValidity proof generation
///
/// Used for ConfigureAccount instruction to prove ownership of ElGamal keypair.
#[derive(Debug, Deserialize)]
pub struct PubkeyValidityRequest {
    /// Wallet public key (base58)
    pub wallet_pubkey: String,

    /// Token account public key (base58)
    pub token_account: String,

    /// Unix timestamp (must be within 5 minutes)
    pub timestamp: i64,

    /// Signature of: "SVS_PROOF_REQUEST" || timestamp || token_account
    /// This proves the wallet owner authorized this proof request
    pub request_signature: String,

    /// Signature used for ElGamal key derivation
    /// Signature of: "ElGamalSecretKey" || token_account
    pub elgamal_signature: String,
}

/// Response for PubkeyValidity proof
#[derive(Debug, Serialize)]
pub struct PubkeyValidityResponse {
    /// The generated proof data (64 bytes, base64 encoded)
    pub proof_data: String,

    /// The derived ElGamal public key (32 bytes, base64 encoded)
    pub elgamal_pubkey: String,
}

/// Request for CiphertextCommitmentEquality proof generation
///
/// Used for Withdraw/Redeem to prove ciphertext encrypts a specific amount.
#[derive(Debug, Deserialize)]
pub struct EqualityProofRequest {
    /// Wallet public key (base58)
    pub wallet_pubkey: String,

    /// Token account public key (base58)
    pub token_account: String,

    /// Unix timestamp (must be within 5 minutes)
    pub timestamp: i64,

    /// Signature of: "SVS_PROOF_REQUEST" || timestamp || token_account
    pub request_signature: String,

    /// Signature used for ElGamal key derivation
    pub elgamal_signature: String,

    /// Current encrypted balance ciphertext (base64 encoded)
    pub current_ciphertext: String,

    /// Amount to prove (as string to handle u64)
    pub amount: String,
}

/// Response for Equality proof
#[derive(Debug, Serialize)]
pub struct EqualityProofResponse {
    /// The generated proof data (192 bytes, base64 encoded)
    pub proof_data: String,
}

/// Request for BatchedRangeProofU64 generation
///
/// Used for Withdraw/Redeem to prove amounts are in valid range.
#[derive(Debug, Deserialize)]
pub struct RangeProofRequest {
    /// Wallet public key (base58)
    pub wallet_pubkey: String,

    /// Unix timestamp (must be within 5 minutes)
    pub timestamp: i64,

    /// Signature of: "SVS_PROOF_REQUEST" || timestamp || "range"
    pub request_signature: String,

    /// Amounts to prove (as strings to handle u64)
    pub amounts: Vec<String>,

    /// Commitment blindings (base64 encoded, one per amount)
    pub commitment_blindings: Vec<String>,
}

/// Response for Range proof
#[derive(Debug, Serialize)]
pub struct RangeProofResponse {
    /// The generated proof data (672+ bytes depending on batch size, base64 encoded)
    pub proof_data: String,
}

/// Health check response
#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub timestamp: i64,
}

/// Configuration for the backend server
#[derive(Debug, Clone)]
pub struct Config {
    /// Server port
    pub port: u16,

    /// CORS allowed origins
    pub cors_origins: Vec<String>,

    /// API keys for authentication
    pub api_keys: Vec<String>,

    /// Request timestamp tolerance in seconds
    pub timestamp_tolerance_secs: i64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: 3001,
            cors_origins: vec!["http://localhost:3000".to_string()],
            api_keys: vec![],
            timestamp_tolerance_secs: 300, // 5 minutes
        }
    }
}

impl Config {
    /// Load configuration from environment variables
    pub fn from_env() -> Self {
        let port = std::env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3001);

        let cors_origins = std::env::var("CORS_ORIGINS")
            .ok()
            .map(|s| s.split(',').map(|s| s.trim().to_string()).collect())
            .unwrap_or_else(|| vec!["http://localhost:3000".to_string()]);

        let api_keys = std::env::var("API_KEYS")
            .ok()
            .map(|s| s.split(',').map(|s| s.trim().to_string()).collect())
            .unwrap_or_default();

        let timestamp_tolerance_secs = std::env::var("TIMESTAMP_TOLERANCE_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(300);

        Self {
            port,
            cors_origins,
            api_keys,
            timestamp_tolerance_secs,
        }
    }
}
