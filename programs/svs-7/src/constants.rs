//! Program constants: PDA seeds, limits, and decimals configuration.

pub const SOL_VAULT_SEED: &[u8] = b"sol_vault";
pub const SHARES_MINT_SEED: &[u8] = b"shares";
pub const WSOL_VAULT_SEED: &[u8] = b"wsol_vault";

pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;
pub const SOL_DECIMALS: u8 = 9;

/// Minimum deposit in lamports (1000 lamports)
pub const MIN_DEPOSIT_AMOUNT: u64 = 1000;

/// SOL has 9 decimals, decimals_offset = 9 - 9 = 0
pub const SOL_DECIMALS_OFFSET: u8 = 0;

/// Minimum SOL to keep for rent exemption (0.01 SOL in lamports)
pub const MIN_RENT_BUFFER: u64 = 10_000_000;

