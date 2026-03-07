//! SVS Access - Access control module for Solana Vault Standard programs.
//!
//! This crate provides access control utilities for SVS vaults:
//! - Open mode: Anyone can interact
//! - Whitelist mode: Only addresses with valid merkle proofs can interact
//! - Blacklist mode: Anyone except addresses with valid merkle proofs can interact
//! - Freeze: Individual accounts can be frozen by admin
//!
//! Uses blake3 for fast merkle tree hashing.
//!
//! # Example
//!
//! ```
//! use svs_access::{check_access, AccessMode, merkle};
//!
//! // Create a whitelist with one user
//! let user = [1u8; 32];
//! let root = merkle::hash_leaf(&user);
//!
//! // Check access
//! assert!(check_access(AccessMode::Whitelist, &root, &user, &[]).is_ok());
//!
//! // Non-whitelisted user is rejected
//! let other = [2u8; 32];
//! assert!(check_access(AccessMode::Whitelist, &root, &other, &[]).is_err());
//! ```

mod error;
mod functions;
pub mod merkle;
mod types;

pub use error::AccessError;
pub use functions::*;
pub use types::AccessMode;
