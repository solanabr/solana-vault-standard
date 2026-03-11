//! SVS-11: Credit Markets Vault
//!
//! KYC-gated, NAV-oracle-priced, investment-window-controlled vault for
//! tokenized credit markets. Extends SVS-10 async lifecycle with:
//!   - KYC attestation checks at request AND approval time
//!   - Manager role (separate from authority) for all approvals
//!   - Investment windows gating new deposits
//!   - Repayment instruction for borrowers to return capital
//!   - Account freeze/unfreeze for compliance

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("BPwDdsFrSSxBRZc6CjTUrmnTVETx7JikhX97KiRvdAwL");

#[program]
pub mod svs_11 {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>, vault_id: u64, manager: Pubkey) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, manager)
    }

    pub fn open_investment_window(ctx: Context<ManagerAdmin>) -> Result<()> {
        instructions::admin::open_investment_window(ctx)
    }

    pub fn close_investment_window(ctx: Context<ManagerAdmin>) -> Result<()> {
        instructions::admin::close_investment_window(ctx)
    }

    pub fn request_deposit(ctx: Context<RequestDeposit>, assets: u64, receiver: Pubkey) -> Result<()> {
        instructions::deposit::request_deposit(ctx, assets, receiver)
    }

    pub fn approve_deposit(ctx: Context<ApproveDeposit>) -> Result<()> {
        instructions::deposit::approve_deposit(ctx)
    }

    pub fn reject_deposit(ctx: Context<RejectDeposit>) -> Result<()> {
        instructions::deposit::reject_deposit(ctx)
    }

    pub fn cancel_deposit(ctx: Context<CancelDeposit>) -> Result<()> {
        instructions::deposit::cancel_deposit(ctx)
    }

    pub fn claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
        instructions::deposit::claim_deposit(ctx)
    }

    pub fn request_redeem(ctx: Context<RequestRedeem>, shares: u64, receiver: Pubkey) -> Result<()> {
        instructions::redeem::request_redeem(ctx, shares, receiver)
    }

    pub fn approve_redeem(ctx: Context<ApproveRedeem>) -> Result<()> {
        instructions::redeem::approve_redeem(ctx)
    }

    pub fn cancel_redeem(ctx: Context<CancelRedeem>) -> Result<()> {
        instructions::redeem::cancel_redeem(ctx)
    }

    pub fn claim_redemption(ctx: Context<ClaimRedemption>) -> Result<()> {
        instructions::redeem::claim_redemption(ctx)
    }

    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        instructions::admin::repay(ctx, amount)
    }

    pub fn freeze_account(ctx: Context<Freeze>) -> Result<()> {
        instructions::admin::freeze_account(ctx)
    }

    pub fn unfreeze_account(ctx: Context<Unfreeze>) -> Result<()> {
        instructions::admin::unfreeze_account(ctx)
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

    pub fn set_manager(ctx: Context<Admin>, new_manager: Pubkey) -> Result<()> {
        instructions::admin::set_manager(ctx, new_manager)
    }
}
