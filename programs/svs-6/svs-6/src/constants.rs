/// PDA seed for the ConfidentialStreamVault account.
pub const VAULT_SEED: &[u8] = b"confidential_stream_vault";

/// PDA seed for the shares mint.
pub const SHARES_MINT_SEED: &[u8] = b"shares";

/// Maximum supported asset decimals.
pub const MAX_DECIMALS: u8 = 9;

/// Share token decimals (always 9 for consistency across all SVS variants).
pub const SHARES_DECIMALS: u8 = 9;

/// Minimum deposit amount in smallest asset units.
/// Prevents dust deposits that waste compute.
pub const MIN_DEPOSIT_AMOUNT: u64 = 1000;

/// Maximum streaming duration: 365 days in seconds.
pub const MAX_STREAM_DURATION: i64 = 365 * 24 * 60 * 60; // 31,536,000

/// Minimum streaming duration: 1 hour in seconds.
pub const MIN_STREAM_DURATION: i64 = 3600;
