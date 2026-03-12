use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::pubkey;

pub const VAULT_SEED: &[u8] = b"credit_vault";
pub const SHARES_MINT_SEED: &[u8] = b"shares";
pub const REDEMPTION_ESCROW_SEED: &[u8] = b"redemption_escrow";
pub const INVESTMENT_REQUEST_SEED: &[u8] = b"investment_request";
pub const REDEMPTION_REQUEST_SEED: &[u8] = b"redemption_request";
pub const CLAIMABLE_TOKENS_SEED: &[u8] = b"claimable_tokens";
pub const FROZEN_ACCOUNT_SEED: &[u8] = b"frozen_account";

pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;
pub const SAS_PROGRAM_ID: Pubkey = pubkey!("4azCqYgLHDRmsiR6kmYu6v5qvzamaYGqZcmx8MrnrKMc");
