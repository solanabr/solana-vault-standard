//! SVS-5: Streaming Yield Vault
//!
//! ERC-4626 compliant tokenized vault for Solana with time-interpolated yield distribution.
//! Instead of yield appearing instantly (SVS-1) or via discrete sync (SVS-2), total assets
//! increase linearly between distribution checkpoints — smooth, continuous share price growth.
//!
//! Key features:
//! - `effective_total_assets(now)` replaces `asset_vault.amount` for all share math
//! - `distribute_yield(amount, duration)` starts a new streaming period
//! - `checkpoint()` is permissionless and finalizes accrued yield into base_assets
//! - Slippage protection, inflation attack protection, Token-2022 shares
//! - Full module compatibility (fees, caps, locks, access, rewards)

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("6M9wqbchLfqdUL9bFVCyet5YEdbBNeHXdvqZAkHfwFRb");

#[program]
pub mod svs_5 {
    use super::*;

    /// Initialize a new streaming yield vault for the given asset.
    pub fn initialize(
        ctx: Context<Initialize>,
        vault_id: u64,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, name, symbol, uri)
    }

    /// Deposit assets and receive shares (floor rounding — favors vault).
    ///
    /// Share price computed at effective_total_assets(now).
    pub fn deposit(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
        instructions::deposit::handler(ctx, assets, min_shares_out)
    }

    /// Mint exact shares by depositing required assets (ceiling rounding — favors vault).
    ///
    /// Share price computed at effective_total_assets(now).
    pub fn mint(ctx: Context<MintShares>, shares: u64, max_assets_in: u64) -> Result<()> {
        instructions::mint::handler(ctx, shares, max_assets_in)
    }

    /// Withdraw exact assets by burning required shares (ceiling rounding — favors vault).
    ///
    /// Share price computed at effective_total_assets(now).
    pub fn withdraw(ctx: Context<Withdraw>, assets: u64, max_shares_in: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, assets, max_shares_in)
    }

    /// Redeem shares for assets (floor rounding — favors vault).
    ///
    /// Share price computed at effective_total_assets(now).
    pub fn redeem(ctx: Context<Redeem>, shares: u64, min_assets_out: u64) -> Result<()> {
        instructions::redeem::handler(ctx, shares, min_assets_out)
    }

    /// Start a new yield stream over the given duration.
    ///
    /// Authority-only. Transfers `yield_amount` tokens from yield_source to the
    /// asset_vault and configures stream parameters. If a stream is already active,
    /// accrued yield is automatically checkpointed first.
    pub fn distribute_yield(
        ctx: Context<DistributeYield>,
        yield_amount: u64,
        duration: i64,
    ) -> Result<()> {
        instructions::distribute_yield::handler(ctx, yield_amount, duration)
    }

    /// Finalize accrued yield into base_assets.
    ///
    /// Permissionless — anyone can call. Advances base_assets by the amount of
    /// yield that has streamed since the last checkpoint. No-op if nothing accrued.
    pub fn checkpoint(ctx: Context<Checkpoint>) -> Result<()> {
        instructions::checkpoint::handler(ctx)
    }

    /// Pause all vault operations (emergency).
    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    /// Unpause vault operations.
    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    /// Transfer vault authority.
    pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::transfer_authority(ctx, new_authority)
    }

    // ============ View Functions (CPI composable) ============

    /// Preview shares for deposit (floor rounding).
    pub fn preview_deposit(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        instructions::view::preview_deposit(ctx, assets)
    }

    /// Preview assets required for mint (ceiling rounding).
    pub fn preview_mint(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::preview_mint(ctx, shares)
    }

    /// Preview shares to burn for withdraw (ceiling rounding).
    pub fn preview_withdraw(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        instructions::view::preview_withdraw(ctx, assets)
    }

    /// Preview assets for redeem (floor rounding).
    pub fn preview_redeem(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::preview_redeem(ctx, shares)
    }

    /// Convert assets to shares (floor rounding).
    pub fn convert_to_shares(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        instructions::view::convert_to_shares_view(ctx, assets)
    }

    /// Convert shares to assets (floor rounding).
    pub fn convert_to_assets(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::convert_to_assets_view(ctx, shares)
    }

    /// Get effective total assets in vault (streaming-aware).
    pub fn total_assets(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::get_total_assets(ctx)
    }

    /// Max assets depositable (u64::MAX or 0 if paused).
    pub fn max_deposit(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_deposit(ctx)
    }

    /// Max shares mintable (u64::MAX or 0 if paused).
    pub fn max_mint(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_mint(ctx)
    }

    /// Max assets owner can withdraw.
    pub fn max_withdraw(ctx: Context<VaultViewWithOwner>) -> Result<()> {
        instructions::view::max_withdraw(ctx)
    }

    /// Max shares owner can redeem.
    pub fn max_redeem(ctx: Context<VaultViewWithOwner>) -> Result<()> {
        instructions::view::max_redeem(ctx)
    }

    // ============ Module Admin Instructions (requires "modules" feature) ============

    /// Initialize fee configuration for vault.
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

    /// Update fee configuration.
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

    /// Initialize cap configuration for vault.
    #[cfg(feature = "modules")]
    pub fn initialize_cap_config(
        ctx: Context<InitializeCapConfig>,
        global_cap: u64,
        per_user_cap: u64,
    ) -> Result<()> {
        instructions::module_admin::initialize_cap_config(ctx, global_cap, per_user_cap)
    }

    /// Update cap configuration.
    #[cfg(feature = "modules")]
    pub fn update_cap_config(
        ctx: Context<UpdateCapConfig>,
        global_cap: Option<u64>,
        per_user_cap: Option<u64>,
    ) -> Result<()> {
        instructions::module_admin::update_cap_config(ctx, global_cap, per_user_cap)
    }

    /// Initialize lock configuration for vault.
    #[cfg(feature = "modules")]
    pub fn initialize_lock_config(
        ctx: Context<InitializeLockConfig>,
        lock_duration: i64,
    ) -> Result<()> {
        instructions::module_admin::initialize_lock_config(ctx, lock_duration)
    }

    /// Update lock configuration.
    #[cfg(feature = "modules")]
    pub fn update_lock_config(ctx: Context<UpdateLockConfig>, lock_duration: i64) -> Result<()> {
        instructions::module_admin::update_lock_config(ctx, lock_duration)
    }

    /// Initialize access configuration for vault.
    #[cfg(feature = "modules")]
    pub fn initialize_access_config(
        ctx: Context<InitializeAccessConfig>,
        mode: state::AccessMode,
        merkle_root: [u8; 32],
    ) -> Result<()> {
        instructions::module_admin::initialize_access_config(ctx, mode, merkle_root)
    }

    /// Update access configuration.
    #[cfg(feature = "modules")]
    pub fn update_access_config(
        ctx: Context<UpdateAccessConfig>,
        mode: Option<state::AccessMode>,
        merkle_root: Option<[u8; 32]>,
    ) -> Result<()> {
        instructions::module_admin::update_access_config(ctx, mode, merkle_root)
    }
}
