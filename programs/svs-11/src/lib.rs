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

    pub fn request_deposit(ctx: Context<RequestDeposit>, amount: u64) -> Result<()> {
        instructions::request_deposit::handler(ctx, amount)
    }

    pub fn approve_deposit(ctx: Context<ApproveDeposit>) -> Result<()> {
        instructions::approve_deposit::handler(ctx)
    }

    pub fn claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
        instructions::claim_deposit::handler(ctx)
    }

    pub fn reject_deposit(ctx: Context<RejectDeposit>) -> Result<()> {
        instructions::reject_deposit::handler(ctx)
    }

    pub fn cancel_deposit(ctx: Context<CancelDeposit>) -> Result<()> {
        instructions::cancel_deposit::handler(ctx)
    }

    pub fn request_redeem(ctx: Context<RequestRedeem>, shares: u64) -> Result<()> {
        instructions::request_redeem::handler(ctx, shares)
    }

    pub fn approve_redeem(ctx: Context<ApproveRedeem>) -> Result<()> {
        instructions::approve_redeem::handler(ctx)
    }

    pub fn claim_redeem(ctx: Context<ClaimRedeem>) -> Result<()> {
        instructions::claim_redeem::handler(ctx)
    }

    pub fn cancel_redeem(ctx: Context<CancelRedeem>) -> Result<()> {
        instructions::cancel_redeem::handler(ctx)
    }
}
