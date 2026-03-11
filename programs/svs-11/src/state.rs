use anchor_lang::prelude::*;

use crate::constants::{
    FROZEN_ACCOUNT_SEED, INVESTMENT_REQUEST_SEED, REDEMPTION_REQUEST_SEED, VAULT_SEED,
};

#[account]
pub struct CreditVault {
    pub authority: Pubkey,
    pub manager: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub deposit_vault: Pubkey,
    pub redemption_escrow: Pubkey,
    pub nav_oracle: Pubkey,
    pub oracle_program: Pubkey,
    pub max_staleness: i64,
    pub sas_credential: Pubkey,
    pub sas_schema: Pubkey,
    pub vault_id: u64,
    pub total_assets: u64,
    pub total_shares: u64,
    pub total_pending_deposits: u64,
    pub minimum_investment: u64,
    pub investment_window_open: bool,
    pub decimals_offset: u8,
    pub bump: u8,
    // Stored because the escrow lives for the vault's lifetime and is used in many CPIs.
    // claimable_tokens has no stored bump — its lifetime is single-instruction-pair
    // (approve_redeem → claim_redeem → close), so the bump is derived fresh each time.
    pub redemption_escrow_bump: u8,
    pub paused: bool,
    pub _reserved: [u8; 64],
}

impl CreditVault {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // authority
        32 +  // manager
        32 +  // asset_mint
        32 +  // shares_mint
        32 +  // deposit_vault
        32 +  // redemption_escrow
        32 +  // nav_oracle
        32 +  // oracle_program
        8 +   // max_staleness
        32 +  // sas_credential
        32 +  // sas_schema
        8 +   // vault_id
        8 +   // total_assets
        8 +   // total_shares
        8 +   // total_pending_deposits
        8 +   // minimum_investment
        1 +   // investment_window_open
        1 +   // decimals_offset
        1 +   // bump
        1 +   // redemption_escrow_bump
        1 +   // paused
        64;   // _reserved

    pub const SEED_PREFIX: &'static [u8] = VAULT_SEED;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RequestStatus {
    Pending,
    Approved,
}

#[account]
pub struct InvestmentRequest {
    pub investor: Pubkey,
    pub vault: Pubkey,
    pub amount_locked: u64,
    pub shares_claimable: u64,
    pub status: RequestStatus,
    pub requested_at: i64,
    pub fulfilled_at: i64,
    pub bump: u8,
}

impl InvestmentRequest {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // investor
        32 +  // vault
        8 +   // amount_locked
        8 +   // shares_claimable
        1 +   // status
        8 +   // requested_at
        8 +   // fulfilled_at
        1;    // bump

    pub const SEED_PREFIX: &'static [u8] = INVESTMENT_REQUEST_SEED;
}

#[account]
pub struct RedemptionRequest {
    pub investor: Pubkey,
    pub vault: Pubkey,
    pub shares_locked: u64,
    pub assets_claimable: u64,
    pub status: RequestStatus,
    pub requested_at: i64,
    pub fulfilled_at: i64,
    pub bump: u8,
}

impl RedemptionRequest {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // investor
        32 +  // vault
        8 +   // shares_locked
        8 +   // assets_claimable
        1 +   // status
        8 +   // requested_at
        8 +   // fulfilled_at
        1;    // bump

    pub const SEED_PREFIX: &'static [u8] = REDEMPTION_REQUEST_SEED;
}

#[account]
pub struct FrozenAccount {
    pub investor: Pubkey,
    pub vault: Pubkey,
    pub frozen_by: Pubkey,
    pub frozen_at: i64,
    pub bump: u8,
}

impl FrozenAccount {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // investor
        32 +  // vault
        32 +  // frozen_by
        8 +   // frozen_at
        1;    // bump

    pub const SEED_PREFIX: &'static [u8] = FROZEN_ACCOUNT_SEED;
}
