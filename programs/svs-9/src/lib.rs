//! SVS-9: Allocator Vault (Vault-of-Vaults)
use anchor_lang::prelude::*;
pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;
use instructions::*;
declare_id!("SVS9aLLocaToR111111111111111111111111111111");
#[program]
pub mod svs_9 {
    use super::*;
    pub fn initialize(ctx: Context<Initialize>, vault_id: u64, name: String, symbol: String, uri: String, idle_buffer_bps: u16) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, name, symbol, uri, idle_buffer_bps)
    }
    pub fn deposit(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
        instructions::deposit::handler(ctx, assets, min_shares_out)
    }
    pub fn redeem(ctx: Context<Redeem>, shares: u64, min_assets_out: u64) -> Result<()> {
        instructions::redeem::handler(ctx, shares, min_assets_out)
    }
    pub fn add_child(ctx: Context<AddChild>, target_weight_bps: u16, max_weight_bps: u16) -> Result<()> {
        instructions::children::add_child(ctx, target_weight_bps, max_weight_bps)
    }
    pub fn remove_child(ctx: Context<RemoveChild>) -> Result<()> {
        instructions::children::remove_child(ctx)
    }
    pub fn update_weights(ctx: Context<UpdateWeights>, target_weight_bps: u16, max_weight_bps: u16) -> Result<()> {
        instructions::children::update_weights(ctx, target_weight_bps, max_weight_bps)
    }
    pub fn toggle_child(ctx: Context<ToggleChild>, enabled: bool) -> Result<()> {
        instructions::children::toggle_child(ctx, enabled)
    }
    pub fn allocate(ctx: Context<CuratorOp>, amount: u64) -> Result<()> {
        instructions::curator::allocate(ctx, amount)
    }
    pub fn deallocate(ctx: Context<CuratorOp>, shares: u64) -> Result<()> {
        instructions::curator::deallocate(ctx, shares)
    }
    pub fn pause(ctx: Context<Admin>) -> Result<()> { instructions::admin::pause(ctx) }
    pub fn unpause(ctx: Context<Admin>) -> Result<()> { instructions::admin::unpause(ctx) }
    pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> { instructions::admin::transfer_authority(ctx, new_authority) }
    pub fn set_curator(ctx: Context<Admin>, new_curator: Pubkey) -> Result<()> { instructions::admin::set_curator(ctx, new_curator) }
    pub fn update_idle_buffer(ctx: Context<Admin>, idle_buffer_bps: u16) -> Result<()> { instructions::admin::update_idle_buffer(ctx, idle_buffer_bps) }
}
