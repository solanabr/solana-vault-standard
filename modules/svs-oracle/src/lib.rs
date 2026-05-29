//! SVS Oracle - the pluggable price-oracle interface for Solana Vault Standard.
//!
//! SVS vaults do not bind to a specific oracle implementation. Instead, any
//! SVS-compliant oracle writes a canonical 24-byte [`SvsOraclePrice`] header
//! (`price` / `timestamp` / `sequence`) at the start of its account payload
//! (immediately after the 8-byte Anchor discriminator); implementation-specific
//! data lives after byte 24 and the consuming vault never reads it. The vault
//! reads the header through one generic [`read_oracle`] function and enforces
//! only the universal invariants — positive price, staleness bound, and
//! sequence monotonicity (replay protection). Per-oracle integrity (e.g.
//! signature verification, consecutive-price deviation) is the oracle
//! program's responsibility.
//!
//! This crate also provides the supporting helpers: freshness/price/deviation
//! validators and assets <-> shares conversion. Used by async vaults
//! (SVS-10/11) where deposits/withdrawals settle against an oracle price.
//! `nav-oracle` is the credit-markets reference implementation; `mock-oracle`
//! is a minimal example; third parties plug in their own.
//!
//! # Example
//!
//! ```
//! use svs_oracle::{read_oracle, SvsOraclePrice, PRICE_SCALE};
//!
//! // An oracle account: 8-byte discriminator + the canonical header.
//! let mut account = vec![0u8; 8];
//! account.extend_from_slice(
//!     &SvsOraclePrice { price: PRICE_SCALE, timestamp: 1500, sequence: 7 }
//!         .to_header_bytes(),
//! );
//!
//! // Generic read: validates price/staleness/monotonicity, returns the header.
//! let header = read_oracle(&account, 1500, 3600, 6).unwrap();
//! assert_eq!(header.price, PRICE_SCALE);
//! ```

mod constants;
mod error;
mod functions;
mod price;

pub use constants::*;
pub use error::OracleError;
pub use functions::*;
pub use price::*;
