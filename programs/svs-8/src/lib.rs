use anchor_lang::prelude::*;

pub mod instructions;
pub mod state;
pub mod error;
pub mod events;
pub mod constants;
pub mod math;

use instructions::*;

declare_id!("E8bGqwitsaFELBtuhbwAKwVBKjAjGzrfcnBPishvvRsA");

#[program]
pub mod svs_8 {
    use super::*;

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
}
