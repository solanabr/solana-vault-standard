//! SVS-7: Native SOL Vault
//!
//! Accepts native SOL directly. Handles wSOL wrapping/unwrapping internally.
//! Exposes both _sol and _wsol interfaces for every operation:
//!   - _sol: end-user friendly, works with native lamports
//!   - _wsol: protocol friendly, works with pre-wrapped wSOL
//!
//! Supports Live (SVS-1 style) and Stored (SVS-2 style) balance models.

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("667t4WhagrxEiR7z5L414LW4HFXfUMn6hk3yE6EpyQth");

#[program]
pub mod svs_7 {
    use super::*;

    /// Initialize a new Native SOL vault
    pub fn initialize(ctx: Context<Initialize>, vault_id: u64, use_stored_model: bool) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, use_stored_model)
    }

    /// Deposit native SOL → mint shares (auto-wraps SOL to wSOL internally)
    pub fn deposit_sol(ctx: Context<DepositSol>, lamports: u64, min_shares_out: u64) -> Result<()> {
        instructions::deposit::deposit_sol(ctx, lamports, min_shares_out)
    }

    /// Deposit pre-wrapped wSOL → mint shares
    pub fn deposit_wsol(ctx: Context<DepositWsol>, lamports: u64, min_shares_out: u64) -> Result<()> {
        instructions::deposit::deposit_wsol(ctx, lamports, min_shares_out)
    }

    /// Pay native SOL to receive exact shares (ceiling rounding)
    pub fn mint_shares(ctx: Context<MintShares>, shares: u64, max_lamports_in: u64) -> Result<()> {
        instructions::mint_shares::mint_shares(ctx, shares, max_lamports_in)
    }

    /// Withdraw exact lamports → burn shares → receive native SOL
    pub fn withdraw_sol(ctx: Context<WithdrawSol>, lamports: u64, max_shares_in: u64) -> Result<()> {
        instructions::withdraw::withdraw_sol(ctx, lamports, max_shares_in)
    }

    /// Withdraw exact lamports → burn shares → receive wSOL
    pub fn withdraw_wsol(ctx: Context<WithdrawWsol>, lamports: u64, max_shares_in: u64) -> Result<()> {
        instructions::withdraw::withdraw_wsol(ctx, lamports, max_shares_in)
    }

    /// Redeem exact shares → receive native SOL (floor rounding)
    pub fn redeem_sol(ctx: Context<RedeemSol>, shares: u64, min_lamports_out: u64) -> Result<()> {
        instructions::redeem::redeem_sol(ctx, shares, min_lamports_out)
    }

    /// Redeem exact shares → receive wSOL (floor rounding)
    pub fn redeem_wsol(ctx: Context<RedeemWsol>, shares: u64, min_lamports_out: u64) -> Result<()> {
        instructions::redeem::redeem_wsol(ctx, shares, min_lamports_out)
    }

    /// Sync total_assets to wsol_vault balance (Stored model only)
    pub fn sync(ctx: Context<Sync>) -> Result<()> {
        instructions::admin::sync(ctx)
    }

    /// Pause all vault operations
    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    /// Unpause vault operations
    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    /// Transfer vault authority to a new address
    pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::transfer_authority(ctx, new_authority)
    }

    // ── View functions (CPI composable via set_return_data) ──

    /// Preview shares for a SOL deposit
    pub fn preview_deposit(ctx: Context<VaultView>, lamports: u64) -> Result<()> {
        instructions::view::preview_deposit(ctx, lamports)
    }

    /// Preview shares to burn for a SOL withdrawal
    pub fn preview_withdraw(ctx: Context<VaultView>, lamports: u64) -> Result<()> {
        instructions::view::preview_withdraw(ctx, lamports)
    }

    /// Preview lamports for redeeming shares
    pub fn preview_redeem(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::preview_redeem(ctx, shares)
    }

    /// Preview lamports required to mint exact shares
    pub fn preview_mint(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::preview_mint(ctx, shares)
    }

    /// Get current total assets (lamports)
    pub fn total_assets(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::get_total_assets(ctx)
    }

    /// Max depositable (u64::MAX or 0 if paused)
    pub fn max_deposit(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_deposit(ctx)
    }

    /// Max redeemable (u64::MAX or 0 if paused)
    pub fn max_redeem(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_redeem(ctx)
    }
}
