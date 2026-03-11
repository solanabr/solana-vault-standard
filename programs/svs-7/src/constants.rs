//! Program constants: PDA seeds, limits, and decimals configuration.

pub const SOL_VAULT_SEED: &[u8] = b"sol_vault";
pub const SHARES_MINT_SEED: &[u8] = b"shares";

pub const SHARES_DECIMALS: u8 = 9;

/// SOL has 9 decimals, so offset exponent = 9 - 9 = 0.
/// We use a fixed offset of 0 (10^0 = 1) but the spec notes
/// consider using a higher offset for better inflation protection.
pub const SOL_DECIMALS: u8 = 9;
pub const SOL_DECIMALS_OFFSET: u8 = 0;

pub const MIN_DEPOSIT_AMOUNT: u64 = 1000;
