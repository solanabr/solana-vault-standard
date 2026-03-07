//! SVS Rewards - Secondary reward token module for Solana Vault Standard programs.
//!
//! This crate provides reward distribution utilities for SVS vaults:
//! - Proportional rewards based on share ownership
//! - MasterChef-style accumulated rewards per share
//! - Support for multiple reward tokens per vault
//!
//! # How it works
//!
//! 1. Rewards are added to the pool via `update_accumulated_per_share`
//! 2. Each user tracks their `reward_debt` (rewards already accounted for)
//! 3. Pending rewards = user_shares * acc_per_share - user_debt + unclaimed
//! 4. On deposit/withdraw, pending rewards move to unclaimed
//! 5. On claim, user receives all pending rewards
//!
//! # Example
//!
//! ```
//! use svs_rewards::{update_accumulated_per_share, on_deposit, on_claim};
//!
//! // Add 1000 rewards to pool with 100k shares
//! let acc = update_accumulated_per_share(0, 1000, 100_000).unwrap();
//!
//! // User deposits 50k shares
//! let (debt, unclaimed) = on_deposit(0, 50_000, acc, 0, 0).unwrap();
//!
//! // More rewards added
//! let acc2 = update_accumulated_per_share(acc, 1000, 150_000).unwrap();
//!
//! // User claims
//! let (claim, _, _) = on_claim(50_000, acc2, debt, unclaimed).unwrap();
//! ```

mod constants;
mod error;
mod functions;

pub use constants::*;
pub use error::RewardError;
pub use functions::*;
