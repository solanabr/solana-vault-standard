//! SVS-7: Native SOL Vault
//!
//! ERC-7535 adapted tokenized vault for Solana. Accepts native SOL (wrapping
//! to wSOL internally) and mints Token-2022 shares. Users interact with
//! native lamports while the vault's internal accounting uses a wSOL token account.
//!
//! Key features:
//! - Dual interface: _sol (native SOL) and _wsol (pre-wrapped) variants
//! - Internal SOL/wSOL wrapping via sync_native
//! - SOL unwrapping via close_account on temporary wSOL accounts
//! - Live or Stored balance model (configurable at init)
//! - Slippage protection via min/max parameters
//! - Inflation attack protection via virtual offset
//! - Token-2022 shares

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;
use state::BalanceModel;

declare_id!("46VK4c9jehfnPRUDVSKxp9LdFdAegnC3WGC49N5MhkUr");

#[program]
pub mod svs_7 {
    use super::*;

    /// Initialize a new SOL vault with wSOL internal accounting
    pub fn initialize(
        ctx: Context<Initialize>,
        vault_id: u64,
        name: String,
        symbol: String,
        uri: String,
        balance_model: BalanceModel,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, name, symbol, uri, balance_model)
    }

    // ============ Deposit ============

    /// Deposit native SOL and receive shares
    pub fn deposit_sol(
        ctx: Context<DepositSol>,
        lamports: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::deposit::deposit_sol_handler(ctx, lamports, min_shares_out)
    }

    /// Deposit pre-wrapped wSOL and receive shares
    pub fn deposit_wsol(
        ctx: Context<DepositWsol>,
        amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::deposit::deposit_wsol_handler(ctx, amount, min_shares_out)
    }

    // ============ Mint ============

    /// Mint exact shares by paying native SOL
    pub fn mint_sol(
        ctx: Context<MintSharesSol>,
        shares: u64,
        max_assets_in: u64,
    ) -> Result<()> {
        instructions::mint::mint_sol_handler(ctx, shares, max_assets_in)
    }

    /// Mint exact shares by paying wSOL
    pub fn mint_wsol(
        ctx: Context<MintSharesWsol>,
        shares: u64,
        max_assets_in: u64,
    ) -> Result<()> {
        instructions::mint::mint_wsol_handler(ctx, shares, max_assets_in)
    }

    // ============ Withdraw ============

    /// Withdraw exact assets as native SOL, burning required shares
    pub fn withdraw_sol(
        ctx: Context<WithdrawSol>,
        lamports: u64,
        max_shares_in: u64,
    ) -> Result<()> {
        instructions::withdraw::withdraw_sol_handler(ctx, lamports, max_shares_in)
    }

    /// Withdraw exact assets as wSOL, burning required shares
    pub fn withdraw_wsol(
        ctx: Context<WithdrawWsol>,
        amount: u64,
        max_shares_in: u64,
    ) -> Result<()> {
        instructions::withdraw::withdraw_wsol_handler(ctx, amount, max_shares_in)
    }

    // ============ Redeem ============

    /// Redeem shares for native SOL
    pub fn redeem_sol(
        ctx: Context<RedeemSol>,
        shares: u64,
        min_assets_out: u64,
    ) -> Result<()> {
        instructions::redeem::redeem_sol_handler(ctx, shares, min_assets_out)
    }

    /// Redeem shares for wSOL
    pub fn redeem_wsol(
        ctx: Context<RedeemWsol>,
        shares: u64,
        min_assets_out: u64,
    ) -> Result<()> {
        instructions::redeem::redeem_wsol_handler(ctx, shares, min_assets_out)
    }

    // ============ Admin ============

    /// Pause all vault operations (emergency)
    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    /// Unpause vault operations
    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    /// Transfer vault authority
    pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::transfer_authority(ctx, new_authority)
    }

    /// Sync total_assets to match wSOL vault balance (Stored model only)
    pub fn sync(ctx: Context<Sync>) -> Result<()> {
        instructions::admin::sync(ctx)
    }

    // ============ View Functions (CPI composable) ============

    /// Preview shares for deposit (floor rounding)
    pub fn preview_deposit(ctx: Context<SolVaultView>, assets: u64) -> Result<()> {
        instructions::view::preview_deposit(ctx, assets)
    }

    /// Preview assets required for mint (ceiling rounding)
    pub fn preview_mint(ctx: Context<SolVaultView>, shares: u64) -> Result<()> {
        instructions::view::preview_mint(ctx, shares)
    }

    /// Preview shares to burn for withdraw (ceiling rounding)
    pub fn preview_withdraw(ctx: Context<SolVaultView>, assets: u64) -> Result<()> {
        instructions::view::preview_withdraw(ctx, assets)
    }

    /// Preview assets for redeem (floor rounding)
    pub fn preview_redeem(ctx: Context<SolVaultView>, shares: u64) -> Result<()> {
        instructions::view::preview_redeem(ctx, shares)
    }

    /// Convert assets to shares (floor rounding)
    pub fn convert_to_shares(ctx: Context<SolVaultView>, assets: u64) -> Result<()> {
        instructions::view::convert_to_shares_view(ctx, assets)
    }

    /// Convert shares to assets (floor rounding)
    pub fn convert_to_assets(ctx: Context<SolVaultView>, shares: u64) -> Result<()> {
        instructions::view::convert_to_assets_view(ctx, shares)
    }

    /// Get total assets in vault
    pub fn total_assets(ctx: Context<SolVaultView>) -> Result<()> {
        instructions::view::get_total_assets(ctx)
    }

    /// Max assets depositable (u64::MAX or 0 if paused)
    pub fn max_deposit(ctx: Context<SolVaultView>) -> Result<()> {
        instructions::view::max_deposit(ctx)
    }

    /// Max shares mintable (u64::MAX or 0 if paused)
    pub fn max_mint(ctx: Context<SolVaultView>) -> Result<()> {
        instructions::view::max_mint(ctx)
    }

    /// Max assets owner can withdraw
    pub fn max_withdraw(ctx: Context<SolVaultViewWithOwner>) -> Result<()> {
        instructions::view::max_withdraw(ctx)
    }

    /// Max shares owner can redeem
    pub fn max_redeem(ctx: Context<SolVaultViewWithOwner>) -> Result<()> {
        instructions::view::max_redeem(ctx)
    }
}
