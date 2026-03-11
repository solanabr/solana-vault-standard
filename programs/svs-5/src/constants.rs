//! Program constants: PDA seeds, limits, and decimals configuration.

pub const STREAM_VAULT_SEED: &[u8] = b"stream_vault";
pub const SHARES_MINT_SEED: &[u8] = b"shares";

pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;

pub const MIN_DEPOSIT_AMOUNT: u64 = 1000;

/// Minimum stream duration in seconds (60 seconds).
pub const MIN_STREAM_DURATION: i64 = 60;
