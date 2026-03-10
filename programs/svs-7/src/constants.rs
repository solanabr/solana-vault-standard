//! Program constants: PDA seeds, limits, and decimals configuration.

pub const VAULT_SEED: &[u8] = b"vault";
pub const SHARES_MINT_SEED: &[u8] = b"shares";

pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;

pub const MIN_DEPOSIT_AMOUNT: u64 = 1000;

pub const WSOL_MINT: anchor_lang::prelude::Pubkey = anchor_lang::solana_program::pubkey!("So11111111111111111111111111111111111111112");