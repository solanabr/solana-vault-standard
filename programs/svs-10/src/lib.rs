//! SVS-10: Async Vault (ERC-7540 port)
//!
//! Implements the request→fulfill→claim lifecycle for deposits and redemptions.
//! An operator processes requests asynchronously — enabling illiquid strategies,
//! off-chain settlement, or any workflow requiring human/algorithmic approval.

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("GBdBKr71wRbGW491tL39ixho1VSHGtCpEkRAk8JC1vmU");

#[program]
pub mod svs_10 {
    use super::*;

    /// Initialize async vault with operator address
    pub fn initialize(ctx: Context<Initialize>, vault_id: u64, operator: Pubkey) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, operator)
    }

    /// Lock assets and create a deposit request
    pub fn request_deposit(ctx: Context<RequestDeposit>, assets: u64, receiver: Pubkey) -> Result<()> {
        instructions::deposit::request_deposit(ctx, assets, receiver)
    }

    /// Cancel a pending deposit request and recover assets
    pub fn cancel_deposit(ctx: Context<CancelDeposit>) -> Result<()> {
        instructions::deposit::cancel_deposit(ctx)
    }

    /// Operator: set shares_claimable and mark request Fulfilled
    pub fn fulfill_deposit(ctx: Context<FulfillDeposit>) -> Result<()> {
        instructions::deposit::fulfill_deposit(ctx)
    }

    /// Claim shares after operator fulfills deposit
    pub fn claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
        instructions::deposit::claim_deposit(ctx)
    }

    /// Lock shares in escrow and create a redeem request
    pub fn request_redeem(ctx: Context<RequestRedeem>, shares: u64, receiver: Pubkey) -> Result<()> {
        instructions::redeem::request_redeem(ctx, shares, receiver)
    }

    /// Cancel a pending redeem request and recover shares
    pub fn cancel_redeem(ctx: Context<CancelRedeem>) -> Result<()> {
        instructions::redeem::cancel_redeem(ctx)
    }

    /// Operator: burn shares, move assets to claimable escrow
    pub fn fulfill_redeem(ctx: Context<FulfillRedeem>) -> Result<()> {
        instructions::redeem::fulfill_redeem(ctx)
    }

    /// Claim assets after operator fulfills redeem
    pub fn claim_redeem(ctx: Context<ClaimRedeem>) -> Result<()> {
        instructions::redeem::claim_redeem(ctx)
    }

    /// Grant or revoke per-user operator approval
    pub fn set_operator(ctx: Context<SetOperator>, operator: Pubkey, approved: bool) -> Result<()> {
        instructions::operator::set_operator(ctx, operator, approved)
    }

    /// Pause all vault operations
    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    /// Unpause vault operations
    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    /// Transfer vault authority
    pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::transfer_authority(ctx, new_authority)
    }

    /// Change vault-level operator
    pub fn set_vault_operator(ctx: Context<Admin>, new_operator: Pubkey) -> Result<()> {
        instructions::admin::set_vault_operator(ctx, new_operator)
    }
}
