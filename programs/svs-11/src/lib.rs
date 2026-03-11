use anchor_lang::prelude::*;

pub mod attestation;
pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod oracle;
pub mod state;

use instructions::*;

declare_id!("Bf17gDR2JdKTWdoTWK3Va9YQtkpePRAAVxMCaokj8ZFW");

#[program]
pub mod svs_11 {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        vault_id: u64,
        name: String,
        symbol: String,
        uri: String,
        minimum_investment: u64,
        max_staleness: i64,
    ) -> Result<()> {
        instructions::initialize_pool::handler(
            ctx,
            vault_id,
            name,
            symbol,
            uri,
            minimum_investment,
            max_staleness,
        )
    }

    pub fn open_investment_window(ctx: Context<InvestmentWindow>) -> Result<()> {
        instructions::investment_window::open_handler(ctx)
    }

    pub fn close_investment_window(ctx: Context<InvestmentWindow>) -> Result<()> {
        instructions::investment_window::close_handler(ctx)
    }
}
