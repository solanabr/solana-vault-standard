pub const VAULT_SEED: &[u8] = b"multi_vault";
pub const SHARES_MINT_SEED: &[u8] = b"shares";
pub const ASSET_ENTRY_SEED: &[u8] = b"asset_entry";
pub const ASSET_VAULT_SEED: &[u8] = b"asset_vault";

pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;
pub const MIN_DEPOSIT_AMOUNT: u64 = 1000;
pub const MAX_ASSETS: u8 = 8;
pub const WEIGHT_DENOMINATOR: u16 = 10_000;
pub const MAX_ORACLE_STALENESS: i64 = 300;
pub const MAX_ORACLE_CONFIDENCE_BPS: u64 = 100;
