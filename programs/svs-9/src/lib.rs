use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;
pub mod utils;

use instructions::*;


declare_id!("CZweMiLWPPgKMiQXVNSuuwaoiHUyKWZzoBhhFg2D1VaU");

#[program]
pub mod svs_9 {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, vault_id: u64, idle_buffer_bps: u16, decimals_offset: u8) -> Result<()> {
        initialize_handler(ctx, vault_id, idle_buffer_bps, decimals_offset)
    }

    pub fn add_child(ctx: Context<AddChild>, max_weight_bps: u16) -> Result<()> {
        add_child_handler(ctx, max_weight_bps)
    }

    pub fn deposit(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
        deposit_handler(ctx, assets, min_shares_out)
    }

    pub fn allocate(ctx: Context<Allocate>, assets: u64) -> Result<()> {
        allocate_handler(ctx, assets)
    }

    pub fn redeem(ctx: Context<Redeem>, shares: u64, min_assets_out: u64) -> Result<()> {
        redeem_handler(ctx, shares, min_assets_out)
    }

    pub fn harvest(ctx: Context<Harvest>) -> Result<()> {
        harvest_handler(ctx)
    }

    pub fn deallocate(ctx: Context<Deallocate>, shares_to_withdraw: u64) -> Result<()> {
        deallocate_handler(ctx, shares_to_withdraw)
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        admin::pause(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        admin::unpause(ctx)
    }

    pub fn transfer_authority(ctx: Context<TransferAuthority>, new_authority: Pubkey) -> Result<()> {
        admin::transfer_authority(ctx, new_authority)
    }

    pub fn set_curator(ctx: Context<SetCurator>, new_curator: Pubkey) -> Result<()> {
        admin::set_curator(ctx, new_curator)
    }

    pub fn remove_child(ctx: Context<RemoveChild>) -> Result<()> {
        remove_child_handler(ctx)
    }

    pub fn update_weights(ctx: Context<UpdateWeights>, new_max_weight_bps: u16) -> Result<()> {
        update_weights_handler(ctx, new_max_weight_bps)
    }

    pub fn rebalance(ctx: Context<Rebalance>) -> Result<()> {
        rebalance_handler(ctx)
    }
}
