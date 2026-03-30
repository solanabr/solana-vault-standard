/// PDA seed for the multi-asset vault account
pub const MULTI_VAULT_SEED: &[u8] = b"multi_vault";

/// PDA seed for asset entry accounts
pub const ASSET_ENTRY_SEED: &[u8] = b"asset_entry";

/// PDA seed for the shares mint
pub const SHARES_SEED: &[u8] = b"shares";

/// Maximum number of assets in a basket
pub const MAX_ASSETS: u8 = 8;

/// Maximum staleness for oracle prices in seconds (60 seconds)
pub const MAX_ORACLE_STALENESS: u64 = 60;

/// Maximum confidence interval in basis points (1% = 100 bps)
pub const MAX_CONFIDENCE_BPS: u64 = 100;

/// Basis points denominator
pub const BPS_DENOMINATOR: u16 = 10_000;

/// Minimum deposit in base units
pub const MIN_DEPOSIT: u64 = 1_000;
/// PDA seed for oracle price accounts
pub const ORACLE_PRICE_SEED: &[u8] = b"oracle_price";
/// Price scale factor (1e9)
pub const PRICE_SCALE: u64 = 1_000_000_000;
