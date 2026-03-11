//! SVS-7 constants: PDA seeds and SOL configuration.

/// PDA seed for SolVault account
pub const SOL_VAULT_SEED: &[u8] = b"sol_vault";

/// PDA seed for the shares mint (Token-2022)
pub const SHARES_MINT_SEED: &[u8] = b"shares";

/// PDA seed for the wSOL token account
pub const WSOL_VAULT_SEED: &[u8] = b"wsol_vault";

/// Shares token always uses 9 decimals
pub const SHARES_DECIMALS: u8 = 9;

/// SOL has 9 decimals
pub const SOL_DECIMALS: u8 = 9;

/// Virtual offset exponent (9 - 9 = 0), so offset = 10^0 = 1
pub const SOL_DECIMALS_OFFSET: u8 = 0;

/// Minimum deposit: 0.001 SOL
pub const MIN_DEPOSIT_LAMPORTS: u64 = 1_000_000;
