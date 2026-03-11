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

    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        instructions::repay::handler(ctx, amount)
    }

    pub fn draw_down(ctx: Context<DrawDown>, amount: u64) -> Result<()> {
        instructions::draw_down::handler(ctx, amount)
    }

    pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
        instructions::compliance::freeze_handler(ctx)
    }

    pub fn unfreeze_account(ctx: Context<UnfreezeAccount>) -> Result<()> {
        instructions::compliance::unfreeze_handler(ctx)
    }

    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::pause_handler(ctx)
    }

    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::unpause_handler(ctx)
    }

    pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::transfer_authority_handler(ctx, new_authority)
    }

    pub fn set_manager(ctx: Context<Admin>, new_manager: Pubkey) -> Result<()> {
        instructions::admin::set_manager_handler(ctx, new_manager)
    }

    pub fn update_sas_config(
        ctx: Context<Admin>,
        new_credential: Pubkey,
        new_schema: Pubkey,
    ) -> Result<()> {
        instructions::admin::update_sas_config_handler(ctx, new_credential, new_schema)
    }
}
