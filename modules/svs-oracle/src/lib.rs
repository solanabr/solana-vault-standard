//! SVS Oracle - Price oracle module for Solana Vault Standard programs.
//!
//! This crate provides oracle price validation for SVS vaults:
//! - Staleness checks: Ensure price is fresh
//! - Price validation: Non-zero, within deviation bounds
//! - Conversion helpers: Assets <-> shares using oracle price
//!
//! Used primarily by async vaults (SVS-10/11) where deposits/withdrawals
//! are processed asynchronously using oracle prices.
//!
//! # Example
//!
//! ```
//! use svs_oracle::{validate_oracle, assets_to_shares, PRICE_SCALE};
//!
//! // Validate oracle is fresh and valid
//! let price = PRICE_SCALE;  // 1.0
//! let updated_at = 1000;
//! let current = 1500;
//! let max_staleness = 3600;
//!
//! assert!(validate_oracle(price, updated_at, current, max_staleness).is_ok());
//!
//! // Convert using oracle price
//! let shares = assets_to_shares(1000, price).unwrap();
//! assert_eq!(shares, 1000);
//! ```

mod constants;
mod error;
mod functions;

pub use constants::*;
pub use error::OracleError;
pub use functions::*;
