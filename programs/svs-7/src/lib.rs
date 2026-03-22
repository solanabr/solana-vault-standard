//! SVS-7: Native SOL Vault
//!
//! ERC-4626 compliant tokenized vault that accepts and returns native SOL.
//! Handles SOL ↔ wSOL wrapping internally so users interact with native lamports
//! while the vault's internal accounting uses a wSOL token account (for DeFi
//! composability with protocols that expect SPL token accounts).
//!
//! Key differences from SVS-1:
//! - Asset is always native SOL (no configurable asset_mint)
//! - Dual interface: `_sol` variants (native SOL) and `_wsol` variants (pre-wrapped)
//! - Live-only: total assets always read from wsol_vault.amount (no sync needed)
//! - PDA seeds: ["sol_vault", vault_id.to_le_bytes()] — no asset_mint in seeds
//! - decimals_offset = 0 (SOL has 9 decimals, 9-9=0)

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("6v6FHxx26oqjJEjZa3S2XiuWSuDbYScd9VB7kLa4yzmE");

#[program]
pub mod svs_7 {
    use super::*;

    // ============ Initialization ============

    /// Initialize a new native SOL vault.
    /// Creates the SolVault PDA, Token-2022 shares mint, and wSOL vault account.
    pub fn initialize(
        ctx: Context<Initialize>,
        vault_id: u64,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id)
    }

    // ============ Native SOL Interface ============

    /// Deposit native SOL and receive vault shares.
    /// The vault wraps SOL to wSOL internally via sync_native.
    /// Returns shares minted (floor rounding — favors vault).
    pub fn deposit_sol(
        ctx: Context<DepositSol>,
        lamports: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::deposit_sol::handler(ctx, lamports, min_shares_out)
    }

    /// Mint exact shares by paying native SOL.
    /// Required SOL computed with ceiling rounding (favors vault).
    pub fn mint_sol(ctx: Context<MintSol>, shares: u64, max_lamports_in: u64) -> Result<()> {
        instructions::mint_sol::handler(ctx, shares, max_lamports_in)
    }

    /// Withdraw exact lamports as native SOL by burning required shares.
    /// Shares burned computed with ceiling rounding (favors vault).
    pub fn withdraw_sol(
        ctx: Context<WithdrawSol>,
        lamports: u64,
        max_shares_in: u64,
    ) -> Result<()> {
        instructions::withdraw_sol::handler(ctx, lamports, max_shares_in)
    }

    /// Redeem exact shares for native SOL.
    /// Assets received computed with floor rounding (favors vault).
    pub fn redeem_sol(
        ctx: Context<RedeemSol>,
        shares: u64,
        min_lamports_out: u64,
    ) -> Result<()> {
        instructions::redeem_sol::handler(ctx, shares, min_lamports_out)
    }

    // ============ wSOL Interface (protocol composability) ============

    /// Deposit pre-wrapped wSOL and receive vault shares.
    /// No sync_native needed — standard SPL transfer.
    pub fn deposit_wsol(
        ctx: Context<DepositWsol>,
        amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::deposit_wsol::handler(ctx, amount, min_shares_out)
    }

    /// Mint exact shares by paying wSOL.
    /// Required wSOL computed with ceiling rounding (favors vault).
    pub fn mint_wsol(ctx: Context<MintWsol>, shares: u64, max_amount_in: u64) -> Result<()> {
        instructions::mint_wsol::handler(ctx, shares, max_amount_in)
    }

    /// Withdraw exact wSOL by burning required shares (no unwrap).
    pub fn withdraw_wsol(
        ctx: Context<WithdrawWsol>,
        lamports: u64,
        max_shares_in: u64,
    ) -> Result<()> {
        instructions::withdraw_wsol::handler(ctx, lamports, max_shares_in)
    }

    /// Redeem exact shares for wSOL (no unwrap).
    pub fn redeem_wsol(
        ctx: Context<RedeemWsol>,
        shares: u64,
        min_assets_out: u64,
    ) -> Result<()> {
        instructions::redeem_wsol::handler(ctx, shares, min_assets_out)
    }

    // ============ Admin ============

    /// Pause all vault operations (emergency circuit breaker)
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

    // ============ View Functions (CPI composable) ============

    /// Preview shares for SOL deposit (floor rounding)
    pub fn preview_deposit(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        instructions::view::preview_deposit(ctx, assets)
    }

    /// Preview SOL required for mint (ceiling rounding)
    pub fn preview_mint(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::preview_mint(ctx, shares)
    }

    /// Preview shares to burn for SOL withdraw (ceiling rounding)
    pub fn preview_withdraw(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        instructions::view::preview_withdraw(ctx, assets)
    }

    /// Preview SOL for share redeem (floor rounding)
    pub fn preview_redeem(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::preview_redeem(ctx, shares)
    }

    /// Convert lamports to shares (floor rounding)
    pub fn convert_to_shares(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        instructions::view::convert_to_shares_view(ctx, assets)
    }

    /// Convert shares to lamports (floor rounding)
    pub fn convert_to_assets(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::convert_to_assets_view(ctx, shares)
    }

    /// Get total lamports managed by vault (model-aware)
    pub fn total_assets(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::get_total_assets(ctx)
    }

    /// Max lamports depositable (u64::MAX or 0 if paused)
    pub fn max_deposit(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_deposit(ctx)
    }

    /// Max shares mintable (u64::MAX or 0 if paused)
    pub fn max_mint(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_mint(ctx)
    }

    /// Max lamports owner can withdraw
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
