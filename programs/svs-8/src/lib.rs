use anchor_lang::prelude::*;

declare_id!("SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j");

pub mod errors;
pub mod events;
pub mod state;
pub mod math;
pub mod oracle;
pub mod instructions;

use instructions::*;

/// SVS-8: Multi-Asset Basket Vault
///
/// A single share token representing proportional ownership of a basket
/// of multiple SPL tokens. Inspired by ERC-7575 (multi-asset vaults).
///
/// Key properties:
/// - Up to 8 underlying assets per vault
/// - Oracle-based share pricing (Pyth / Switchboard / svs-oracle)
/// - Single-asset or proportional deposits/redemptions
/// - Authority-controlled rebalancing via Jupiter CPI
/// - Full SVS module system compatibility (fees, caps, locks, rewards, access)
#[program]
pub mod svs_8 {
    use super::*;

    /// Create a new multi-asset basket vault with a fresh share mint.
    pub fn initialize(
        ctx: Context<Initialize>,
        vault_id: u64,
        decimals_offset: u8,
        idle_buffer_bps: u16,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, decimals_offset, idle_buffer_bps)
    }

    /// Add an asset to the basket. Total weights must not exceed 10_000 bps.
    pub fn add_asset(
        ctx: Context<AddAsset>,
        target_weight_bps: u16,
    ) -> Result<()> {
        instructions::add_asset::handler(ctx, target_weight_bps)
    }

    /// Remove an asset from the basket. Asset vault must be empty.
    pub fn remove_asset(ctx: Context<RemoveAsset>) -> Result<()> {
        instructions::remove_asset::handler(ctx)
    }

    /// Update target allocation weights. Sum must equal 10_000 bps.
    pub fn update_weights(
        ctx: Context<UpdateWeights>,
        new_weights: Vec<u16>,
    ) -> Result<()> {
        instructions::update_weights::handler(ctx, new_weights)
    }

    /// Deposit a single basket asset and receive share tokens.
    /// Share price is computed from the oracle-denominated total portfolio value.
    pub fn deposit_single(
        ctx: Context<DepositSingle>,
        amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::deposit_single::handler(ctx, amount, min_shares_out)
    }

    /// Deposit all basket assets proportionally (according to target weights)
    /// and receive share tokens.
    pub fn deposit_proportional(
        ctx: Context<DepositProportional>,
        base_amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::deposit_proportional::handler(ctx, base_amount, min_shares_out)
    }

    /// Redeem a single basket asset from shares.
    pub fn redeem_single(
        ctx: Context<RedeemSingle>,
        shares: u64,
        asset_index: u8,
        min_amount_out: u64,
    ) -> Result<()> {
        instructions::redeem_single::handler(ctx, shares, asset_index, min_amount_out)
    }

    /// Redeem all basket assets proportionally from shares.
    pub fn redeem_proportional(
        ctx: Context<RedeemProportional>,
        shares: u64,
        min_values_out: Vec<u64>,
    ) -> Result<()> {
        instructions::redeem_proportional::handler(ctx, shares, min_values_out)
    }

    /// Rebalance basket via Jupiter aggregator CPI.
    /// Swaps from_asset to to_asset to match target weights.
    pub fn rebalance(
        ctx: Context<Rebalance>,
        route_data: Vec<u8>,
        minimum_out: u64,
    ) -> Result<()> {
        instructions::rebalance::handler(ctx, route_data, minimum_out)
    }

    /// Pause all financial operations (emergency).
    pub fn pause(ctx: Context<SetPaused>) -> Result<()> {
        instructions::set_paused::handler(ctx, true)
    }

    /// Resume financial operations.
    pub fn unpause(ctx: Context<SetPaused>) -> Result<()> {
        instructions::set_paused::handler(ctx, false)
    }

    /// Transfer vault authority to a new pubkey.
    pub fn transfer_authority(
        ctx: Context<TransferAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::transfer_authority::handler(ctx, new_authority)
    }
}
