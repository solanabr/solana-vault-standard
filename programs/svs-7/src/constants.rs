//! Program constants: PDA seeds, native mint, and decimals configuration.

use anchor_lang::prelude::Pubkey;

/// PDA seed for the SolVault account
pub const SOL_VAULT_SEED: &[u8] = b"sol_vault";

/// PDA seed for the shares mint
pub const SHARES_MINT_SEED: &[u8] = b"shares";

/// SOL has 9 decimals — shares mirror this
pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;

/// Minimum deposit in lamports (dust protection)
pub const MIN_DEPOSIT_AMOUNT: u64 = 1000;

/// Native SOL mint address (So11111111111111111111111111111111)
pub const NATIVE_MINT: Pubkey =
    anchor_lang::solana_program::pubkey!("So11111111111111111111111111111111111111112");
