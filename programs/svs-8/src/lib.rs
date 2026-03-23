use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod remaining;
pub mod state;

use instructions::*;

declare_id!("ESPx6aLuszKwk5oKSWLoCkAj9Pc7EpSSEezhNX5aPw6r");

#[program]
pub mod svs_8 {
    use super::*;

    /// Initialize a new multi-asset vault
    pub fn initialize(ctx: Context<Initialize>, vault_id: u64, base_decimals: u8) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, base_decimals)
    }

    /// Add an asset to the vault basket
    pub fn add_asset(
        ctx: Context<AddAsset>,
        target_weight_bps: u16,
        oracle_type: u8,
    ) -> Result<()> {
        instructions::add_asset::handler(ctx, target_weight_bps, oracle_type)
    }

    /// Remove an asset from the vault basket (must have zero balance)
    pub fn remove_asset(ctx: Context<RemoveAsset>) -> Result<()> {
        instructions::remove_asset::handler(ctx)
    }

    /// Update target weights for all assets (must sum to 10000)
    pub fn update_weights(ctx: Context<UpdateWeights>, new_weights: Vec<u16>) -> Result<()> {
        instructions::update_weights::handler(ctx, new_weights)
    }

    /// Deposit a single asset, receive shares based on oracle-priced portfolio value
    pub fn deposit_single(
        ctx: Context<DepositSingle>,
        amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::deposit_single::handler(ctx, amount, min_shares_out)
    }

    /// Deposit all assets in target weight proportions, receive shares
    pub fn deposit_proportional<'info>(
        ctx: Context<'_, '_, 'info, 'info, DepositProportional<'info>>,
        base_amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::deposit_proportional::handler(ctx, base_amount, min_shares_out)
    }

    /// Redeem shares for a single asset (proportional to balance, no oracle needed)
    pub fn redeem_single(
        ctx: Context<RedeemSingle>,
        shares: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        instructions::redeem_single::handler(ctx, shares, min_amount_out)
    }

    /// Redeem shares for proportional basket of all assets
    pub fn redeem_proportional<'info>(
        ctx: Context<'_, '_, 'info, 'info, RedeemProportional<'info>>,
        shares: u64,
        min_amounts_out: Vec<u64>,
    ) -> Result<()> {
        instructions::redeem_proportional::handler(ctx, shares, min_amounts_out)
    }

    /// Rebalance between two asset vaults via external swap program
    pub fn rebalance<'info>(
        ctx: Context<'_, '_, 'info, 'info, Rebalance<'info>>,
        swap_data: Vec<u8>,
        minimum_out: u64,
    ) -> Result<()> {
        instructions::rebalance::handler(ctx, swap_data, minimum_out)
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

    // ============ View Functions ============

    /// Preview shares for deposit_single
    pub fn preview_deposit(ctx: Context<VaultView>, asset_index: u8, amount: u64) -> Result<()> {
        instructions::view::preview_deposit(ctx, asset_index, amount)
    }

    /// Get total portfolio value in base units
    pub fn total_portfolio_value(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::get_total_portfolio_value(ctx)
    }

    /// Preview redeem_single: assets out for given shares
    pub fn preview_redeem_single(
        ctx: Context<VaultView>,
        asset_index: u8,
        shares: u64,
    ) -> Result<()> {
        instructions::view::preview_redeem_single(ctx, asset_index, shares)
    }

    /// Convert shares to base-unit value
    pub fn convert_shares_to_value(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::convert_shares_to_value(ctx, shares)
    }

    // ============ Test Utilities ============

    #[cfg(feature = "test-utils")]
    pub fn set_oracle_data(ctx: Context<SetOracleData>, price: u64, timestamp: i64) -> Result<()> {
        instructions::test_utils::handler(ctx, price, timestamp)
    }
}
