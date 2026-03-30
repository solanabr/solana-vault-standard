//! Program constants: PDA seeds, limits, and decimals configuration.

pub const VAULT_SEED: &[u8] = b"async_vault";
pub const SHARES_MINT_SEED: &[u8] = b"shares";
pub const SHARE_ESCROW_SEED: &[u8] = b"share_escrow";
pub const DEPOSIT_REQUEST_SEED: &[u8] = b"deposit_request";
pub const REDEEM_REQUEST_SEED: &[u8] = b"redeem_request";
pub const CLAIMABLE_TOKENS_SEED: &[u8] = b"claimable_tokens";
pub const OPERATOR_APPROVAL_SEED: &[u8] = b"operator_approval";

pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;
pub const MIN_DEPOSIT_AMOUNT: u64 = 1000;
pub const DEFAULT_MAX_DEVIATION_BPS: u16 = 500; // 5%
pub const DEFAULT_CANCEL_AFTER: i64 = 0; // disabled by default
