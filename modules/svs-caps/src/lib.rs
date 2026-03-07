//! SVS Caps - Deposit cap module for Solana Vault Standard programs.
//!
//! This crate provides cap enforcement utilities for SVS vaults:
//! - Global cap: Maximum total assets the vault can accept
//! - Per-user cap: Maximum assets any single user can deposit
//!
//! A cap value of 0 means unlimited (no cap enforced).
//!
//! # Example
//!
//! ```
//! use svs_caps::{check_global_cap, check_user_cap, max_deposit_for_user};
//!
//! // Check if deposit would exceed global cap
//! assert!(check_global_cap(900_000, 50_000, 1_000_000).is_ok());
//!
//! // Check if deposit would exceed user cap
//! assert!(check_user_cap(50_000, 40_000, 100_000).is_ok());
//!
//! // Calculate max deposit allowed
//! let max = max_deposit_for_user(500_000, 30_000, 1_000_000, 100_000);
//! assert_eq!(max, 70_000);
//! ```

mod error;
mod functions;

pub use error::CapError;
pub use functions::*;
