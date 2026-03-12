use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;
pub mod waterfall;

use instructions::*;

declare_id!("85wwufKdhpHxiBe4kMeFBfidL1Kqo62T65DHb46qNugA");

#[program]
pub mod svs_12 {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, vault_id: u64, waterfall_mode: u8) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, waterfall_mode)
    }

    pub fn add_tranche(
        ctx: Context<AddTranche>,
        priority: u8,
        subordination_bps: u16,
        target_yield_bps: u16,
        cap_bps: u16,
    ) -> Result<()> {
        instructions::add_tranche::handler(
            ctx,
            priority,
            subordination_bps,
            target_yield_bps,
            cap_bps,
        )
    }
}
