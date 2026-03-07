//! SVS Locks - Time-lock module for Solana Vault Standard programs.
//!
//! This crate provides time-lock enforcement utilities for SVS vaults:
//! - Lock periods: Prevent share redemption for a configurable duration
//! - Lock extension: Extend locks on additional deposits
//! - Lock validation: Check remaining time and enforce limits
//!
//! Lock duration of 0 means instant redemption (no lock).
//! Maximum lock duration is 1 year to prevent indefinite locks.
//!
//! # Example
//!
//! ```
//! use svs_locks::{check_lockup, set_lock, remaining_lock_time};
//!
//! // User deposits at timestamp 1000 with 1-day lock
//! let locked_until = set_lock(1000, 86400).unwrap();
//! assert_eq!(locked_until, 87400);
//!
//! // Check if can redeem at timestamp 100000 (after lock expires)
//! assert!(check_lockup(locked_until, 100000).is_ok()); // Unlocked
//!
//! // Check remaining time at 5000 (82400 seconds left)
//! assert_eq!(remaining_lock_time(locked_until, 5000), 82400);
//! ```

mod constants;
mod error;
mod functions;

pub use constants::*;
pub use error::LockError;
pub use functions::*;
