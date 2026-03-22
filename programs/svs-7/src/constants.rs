//! Program constants: PDA seeds, native mint, and decimals configuration.

/// PDA seed for the SolVault account
pub const SOL_VAULT_SEED: &[u8] = b"sol_vault";

/// PDA seed for the shares mint
pub const SHARES_MINT_SEED: &[u8] = b"shares";

/// SOL has 9 decimals — shares mirror this
pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;

/// Minimum deposit in lamports (dust protection)
pub const MIN_DEPOSIT_AMOUNT: u64 = 1000;

/// Native SOL mint — imported from the audited SPL crate (no hardcoded address)
pub use spl_token_2022::native_mint::ID as NATIVE_MINT;
