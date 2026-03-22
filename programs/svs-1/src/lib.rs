//! SVS-1: Public Vault with Live Balance
//!
//! ERC-4626 compliant tokenized vault for Solana. Deposits assets, mints shares,
//! and reads balance directly from the asset vault account (live balance model).
//!
//! Key features:
//! - Slippage protection via min/max parameters
//! - Inflation attack protection via virtual offset
//! - Token-2022 shares, SPL Token or Token-2022 assets

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC");

#[program]
pub mod svs_1 {
    use super::*;

    /// Initialize a new vault for the given asset
    pub fn initialize(
        ctx: Context<Initialize>,
        vault_id: u64,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, name, symbol, uri)
    }

    /// Deposit assets and receive shares
    /// Returns shares minted (floor rounding - favors vault)
    pub fn deposit(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
        instructions::deposit::handler(ctx, assets, min_shares_out)
    }

    /// Mint exact shares by depositing required assets
    /// Pays assets (ceiling rounding - favors vault)
    pub fn mint(ctx: Context<MintShares>, shares: u64, max_assets_in: u64) -> Result<()> {
        instructions::mint::handler(ctx, shares, max_assets_in)
    }

    /// Withdraw exact assets by burning required shares
    /// Burns shares (ceiling rounding - favors vault)
    pub fn withdraw(ctx: Context<Withdraw>, assets: u64, max_shares_in: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, assets, max_shares_in)
    }

    /// Redeem shares for assets
    /// Receives assets (floor rounding - favors vault)
    pub fn redeem(ctx: Context<Redeem>, shares: u64, min_assets_out: u64) -> Result<()> {
        instructions::redeem::handler(ctx, shares, min_assets_out)
    }

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

    // NOTE: SVS-1 uses live balance - no sync() needed
    // For controlled yield distribution, use SVS-2 which has sync()

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
        instructions::view::get_total_assets(ctx)
    }

    /// Max assets depositable (u64::MAX or 0 if paused)
    pub fn max_deposit(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_deposit(ctx)
    }

    /// Max shares mintable (u64::MAX or 0 if paused)
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

    /// Initialize fee configuration for vault
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

    /// Update fee configuration
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

    /// Initialize cap configuration for vault
    #[cfg(feature = "modules")]
    pub fn initialize_cap_config(
        ctx: Context<InitializeCapConfig>,
        global_cap: u64,
        per_user_cap: u64,
    ) -> Result<()> {
        instructions::module_admin::initialize_cap_config(ctx, global_cap, per_user_cap)
    }

    /// Update cap configuration
    #[cfg(feature = "modules")]
    pub fn update_cap_config(
        ctx: Context<UpdateCapConfig>,
        global_cap: Option<u64>,
        per_user_cap: Option<u64>,
    ) -> Result<()> {
        instructions::module_admin::update_cap_config(ctx, global_cap, per_user_cap)
    }

    /// Initialize lock configuration for vault
    #[cfg(feature = "modules")]
    pub fn initialize_lock_config(
        ctx: Context<InitializeLockConfig>,
        lock_duration: i64,
    ) -> Result<()> {
        instructions::module_admin::initialize_lock_config(ctx, lock_duration)
    }

    /// Update lock configuration
    #[cfg(feature = "modules")]
    pub fn update_lock_config(ctx: Context<UpdateLockConfig>, lock_duration: i64) -> Result<()> {
        instructions::module_admin::update_lock_config(ctx, lock_duration)
    }

    /// Initialize access configuration for vault
    #[cfg(feature = "modules")]
    pub fn initialize_access_config(
        ctx: Context<InitializeAccessConfig>,
        mode: state::AccessMode,
        merkle_root: [u8; 32],
    ) -> Result<()> {
        instructions::module_admin::initialize_access_config(ctx, mode, merkle_root)
    }

    /// Update access configuration
    #[cfg(feature = "modules")]
    pub fn update_access_config(
        ctx: Context<UpdateAccessConfig>,
        mode: Option<state::AccessMode>,
        merkle_root: Option<[u8; 32]>,
    ) -> Result<()> {
        instructions::module_admin::update_access_config(ctx, mode, merkle_root)
    }
}
