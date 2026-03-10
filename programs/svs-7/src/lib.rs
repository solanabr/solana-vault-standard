//! SVS-7: Native SOL Vault
//!
//! Solana vault that accepts native SOL directly, handling SOL ↔ wSOL wrapping
//! internally. Users interact with lamports, vault uses a wSOL token account
//! for accounting.
//!
//! Key features:
//! - Native SOL deposits and withdrawals (no user-side wrapping)
//! - wSOL interface for protocol composability
//! - Dual balance model: Live (reads wsol_vault.amount) or Stored (uses vault.total_assets)
//! - Slippage protection via min/max parameters
//! - Inflation attack protection via virtual offset
//! - Token-2022 shares, SPL Token wSOL for assets

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("SVSxBmEB9ZAaHMJ4PJPsLDu56bGjoXKNsSp1bWKyMYC");

#[program]
pub mod svs_7 {
    use super::*;

    /// Initialize a new native SOL vault
    pub fn initialize(
        ctx: Context<Initialize>,
        vault_id: u64,
        balance_model: u8,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, balance_model, name, symbol, uri)
    }

    // ============ Deposit Instructions ============

    /// Deposit native SOL and receive shares
    /// SOL is wrapped to wSOL internally
    pub fn deposit_sol(
        ctx: Context<DepositSol>,
        lamports: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::deposit_sol::handler(ctx, lamports, min_shares_out)
    }

    /// Deposit pre-wrapped wSOL and receive shares
    /// For protocol composability
    pub fn deposit_wsol(
        ctx: Context<DepositWsol>,
        amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::deposit_wsol::handler(ctx, amount, min_shares_out)
    }

    /// Mint exact shares by paying native SOL
    /// SOL cost uses ceiling rounding (favors vault)
    pub fn mint_sol(
        ctx: Context<MintSol>,
        shares: u64,
        max_lamports_in: u64,
    ) -> Result<()> {
        instructions::mint_sol::handler(ctx, shares, max_lamports_in)
    }

    // ============ Withdraw Instructions ============

    /// Withdraw exact lamports of native SOL by burning shares
    /// Returns native SOL (unwrapped from wSOL internally)
    pub fn withdraw_sol(
        ctx: Context<WithdrawSol>,
        lamports: u64,
        max_shares_in: u64,
    ) -> Result<()> {
        instructions::withdraw_sol::handler(ctx, lamports, max_shares_in)
    }

    /// Withdraw exact wSOL by burning shares
    /// Returns pre-wrapped wSOL for protocol composability
    pub fn withdraw_wsol(
        ctx: Context<WithdrawWsol>,
        amount: u64,
        max_shares_in: u64,
    ) -> Result<()> {
        instructions::withdraw_wsol::handler(ctx, amount, max_shares_in)
    }

    // ============ Redeem Instructions ============

    /// Redeem shares for native SOL (floor rounding — favors vault)
    pub fn redeem_sol(
        ctx: Context<RedeemSol>,
        shares: u64,
        min_lamports_out: u64,
    ) -> Result<()> {
        instructions::redeem_sol::handler(ctx, shares, min_lamports_out)
    }

    /// Redeem shares for wSOL (floor rounding — favors vault)
    pub fn redeem_wsol(
        ctx: Context<RedeemWsol>,
        shares: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        instructions::redeem_wsol::handler(ctx, shares, min_amount_out)
    }

    // ============ Admin Instructions ============

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

    /// Sync stored total_assets to live balance (Stored model only)
    pub fn sync(ctx: Context<Sync>) -> Result<()> {
        instructions::admin::sync(ctx)
    }

    // ============ View Functions (CPI composable) ============

    /// Preview shares for deposit (floor rounding)
    pub fn preview_deposit(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        instructions::view::preview_deposit(ctx, assets)
    }

    /// Preview assets required for mint (ceiling rounding)
    pub fn preview_mint(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::preview_mint(ctx, shares)
    }

    /// Preview shares to burn for withdraw (ceiling rounding)
    pub fn preview_withdraw(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        instructions::view::preview_withdraw(ctx, assets)
    }

    /// Preview assets for redeem (floor rounding)
    pub fn preview_redeem(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::preview_redeem(ctx, shares)
    }

    /// Convert assets to shares (floor rounding)
    pub fn convert_to_shares(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        instructions::view::convert_to_shares_view(ctx, assets)
    }

    /// Convert shares to assets (floor rounding)
    pub fn convert_to_assets(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::convert_to_assets_view(ctx, shares)
    }

    /// Get total assets in vault
    pub fn total_assets(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::get_total_assets_view(ctx)
    }

    /// Max assets depositable
    pub fn max_deposit(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_deposit(ctx)
    }

    /// Max shares mintable
    pub fn max_mint(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_mint(ctx)
    }

    /// Max assets owner can withdraw
    pub fn max_withdraw(ctx: Context<VaultViewWithOwner>) -> Result<()> {
        instructions::view::max_withdraw(ctx)
    }

    /// Max shares owner can redeem
    pub fn max_redeem(ctx: Context<VaultViewWithOwner>) -> Result<()> {
        instructions::view::max_redeem(ctx)
    }

    // ============ Module Admin Instructions (requires "modules" feature) ============

    #[cfg(feature = "modules")]
    pub fn initialize_fee_config(
        ctx: Context<InitializeFeeConfig>,
        entry_fee_bps: u16,
        exit_fee_bps: u16,
        management_fee_bps: u16,
        performance_fee_bps: u16,
    ) -> Result<()> {
        instructions::module_admin::initialize_fee_config(
            ctx,
            entry_fee_bps,
            exit_fee_bps,
            management_fee_bps,
            performance_fee_bps,
        )
    }

    #[cfg(feature = "modules")]
    pub fn update_fee_config(
        ctx: Context<UpdateFeeConfig>,
        entry_fee_bps: Option<u16>,
        exit_fee_bps: Option<u16>,
        management_fee_bps: Option<u16>,
        performance_fee_bps: Option<u16>,
    ) -> Result<()> {
        instructions::module_admin::update_fee_config(
            ctx,
            entry_fee_bps,
            exit_fee_bps,
            management_fee_bps,
            performance_fee_bps,
        )
    }

    #[cfg(feature = "modules")]
    pub fn initialize_cap_config(
        ctx: Context<InitializeCapConfig>,
        global_cap: u64,
        per_user_cap: u64,
    ) -> Result<()> {
        instructions::module_admin::initialize_cap_config(ctx, global_cap, per_user_cap)
    }

    #[cfg(feature = "modules")]
    pub fn update_cap_config(
        ctx: Context<UpdateCapConfig>,
        global_cap: Option<u64>,
        per_user_cap: Option<u64>,
    ) -> Result<()> {
        instructions::module_admin::update_cap_config(ctx, global_cap, per_user_cap)
    }

    #[cfg(feature = "modules")]
    pub fn initialize_lock_config(
        ctx: Context<InitializeLockConfig>,
        lock_duration: i64,
    ) -> Result<()> {
        instructions::module_admin::initialize_lock_config(ctx, lock_duration)
    }

    #[cfg(feature = "modules")]
    pub fn update_lock_config(
        ctx: Context<UpdateLockConfig>,
        lock_duration: i64,
    ) -> Result<()> {
        instructions::module_admin::update_lock_config(ctx, lock_duration)
    }

    #[cfg(feature = "modules")]
    pub fn initialize_access_config(
        ctx: Context<InitializeAccessConfig>,
        mode: state::AccessMode,
        merkle_root: [u8; 32],
    ) -> Result<()> {
        instructions::module_admin::initialize_access_config(ctx, mode, merkle_root)
    }

    #[cfg(feature = "modules")]
    pub fn update_access_config(
        ctx: Context<UpdateAccessConfig>,
        mode: Option<state::AccessMode>,
        merkle_root: Option<[u8; 32]>,
    ) -> Result<()> {
        instructions::module_admin::update_access_config(ctx, mode, merkle_root)
    }
}
