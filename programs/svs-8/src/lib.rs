use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("E8bGqwitsaFELBtuhbwAKwVBKjAjGzrfcnBPishvvRsA");

#[program]
pub mod svs_8 {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        vault_id: u64,
        name: String,
        symbol: String,
        uri: String,
        base_decimals: u8,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, name, symbol, uri, base_decimals)
    }

    pub fn add_asset(
        ctx: Context<AddAsset>,
        target_weight_bps: u16,
    ) -> Result<()> {
        instructions::add_asset::handler(ctx, target_weight_bps)
    }

    pub fn remove_asset(ctx: Context<RemoveAsset>) -> Result<()> {
        instructions::remove_asset::handler(ctx)
    }

    pub fn update_weights(
        ctx: Context<UpdateWeights>,
        new_weight_bps: u16,
    ) -> Result<()> {
        instructions::update_weights::handler(ctx, new_weight_bps)
    }

    pub fn deposit_single(
        ctx: Context<DepositSingle>,
        amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::deposit_single::handler(ctx, amount, min_shares_out)
    }

    pub fn deposit_proportional(
        ctx: Context<DepositProportional>,
        base_amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::deposit_proportional::handler(ctx, base_amount, min_shares_out)
    }

    pub fn redeem_proportional(
        ctx: Context<RedeemProportional>,
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

    pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::transfer_authority(ctx, new_authority)
    }
}
