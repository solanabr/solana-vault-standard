use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("HnZ9N8Y1v6jMhwDqo4Y76GfqjRArdinadgK67yLVFZbe");

#[program]
pub mod svs_8 {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        vault_id: u64,
        base_decimals: u8,
        shares_decimals: u8,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, base_decimals, shares_decimals)
    }

    pub fn add_asset(ctx: Context<AddAsset>, target_weight_bps: u16) -> Result<()> {
        instructions::add_asset::handler(ctx, target_weight_bps)
    }

    pub fn remove_asset(ctx: Context<RemoveAsset>) -> Result<()> {
        instructions::remove_asset::handler(ctx)
    }

    pub fn update_weights(ctx: Context<UpdateWeights>, new_weight_bps: u16) -> Result<()> {
        instructions::update_weights::handler(ctx, new_weight_bps)
    }

    pub fn deposit_single(
        ctx: Context<DepositSingle>,
        amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::deposit_single::handler(ctx, amount, min_shares_out)
    }

    pub fn deposit_proportional<'info>(
        ctx: Context<'_, '_, '_, 'info, DepositProportional<'info>>,
        base_amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::deposit_proportional::handler(ctx, base_amount, min_shares_out)
    }

    pub fn redeem_proportional<'info>(
        ctx: Context<'_, '_, '_, 'info, RedeemProportional<'info>>,
        shares: u64,
        min_assets_out: u64,
    ) -> Result<()> {
        instructions::redeem_proportional::handler(ctx, shares, min_assets_out)
    }

    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    pub fn initialize_oracle(ctx: Context<InitializeOracle>, price: u64) -> Result<()> {
        instructions::update_oracle::initialize_oracle_handler(ctx, price)
    }

    pub fn update_oracle(ctx: Context<UpdateOracle>, price: u64) -> Result<()> {
        instructions::update_oracle::handler(ctx, price)
    }

    pub fn redeem_single(
        ctx: Context<RedeemSingle>,
        shares: u64,
        min_assets_out: u64,
    ) -> Result<()> {
        instructions::redeem_single::handler(ctx, shares, min_assets_out)
    }
    /// Step 1: Request authority transfer (sets pending_authority)
    pub fn request_transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::request_transfer_authority(ctx, new_authority)
    }

    /// Step 2: Accept authority transfer (must be signed by pending authority)
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        instructions::admin::accept_authority(ctx)
    }

    /// Direct transfer authority (deprecated -- prefer two-step transfer)
    #[allow(deprecated)]
    pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::transfer_authority(ctx, new_authority)
    }

    /// Cancel a pending two-step authority transfer.
    pub fn cancel_transfer_authority(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::cancel_transfer_authority(ctx)
    }
}
