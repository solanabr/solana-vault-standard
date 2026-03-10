use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;

use crate::{
    constants::*,
    state::{AsyncVault, ClaimableEscrow, DepositRequest, RedeemRequest, RequestStatus},
};

#[derive(Accounts)]
pub struct PendingDepositView<'info> {
    pub vault: Account<'info, AsyncVault>,

    #[account(
        has_one = vault,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), deposit_request.owner.as_ref()],
        bump = deposit_request.bump,
    )]
    pub deposit_request: Account<'info, DepositRequest>,
}

#[derive(Accounts)]
pub struct ClaimableDepositView<'info> {
    pub vault: Account<'info, AsyncVault>,

    #[account(
        has_one = vault,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), deposit_request.owner.as_ref()],
        bump = deposit_request.bump,
    )]
    pub deposit_request: Account<'info, DepositRequest>,
}

#[derive(Accounts)]
pub struct PendingRedeemView<'info> {
    pub vault: Account<'info, AsyncVault>,

    #[account(
        has_one = vault,
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), redeem_request.owner.as_ref()],
        bump = redeem_request.bump,
    )]
    pub redeem_request: Account<'info, RedeemRequest>,
}

#[derive(Accounts)]
pub struct ClaimableRedeemView<'info> {
    pub vault: Account<'info, AsyncVault>,

    #[account(
        has_one = vault,
        seeds = [CLAIMABLE_SEED, vault.key().as_ref(), claimable_escrow.owner.as_ref()],
        bump = claimable_escrow.bump,
    )]
    pub claimable_escrow: Account<'info, ClaimableEscrow>,
}

pub fn pending_deposit_request(ctx: Context<PendingDepositView>) -> Result<()> {
    let request = &ctx.accounts.deposit_request;
    let value = if request.status == RequestStatus::Pending {
        request.assets_locked
    } else {
        0
    };
    set_return_data(&value.to_le_bytes());
    Ok(())
}

pub fn claimable_deposit_request(ctx: Context<ClaimableDepositView>) -> Result<()> {
    let request = &ctx.accounts.deposit_request;
    let value = if request.status == RequestStatus::Fulfilled {
        request.shares_claimable
    } else {
        0
    };
    set_return_data(&value.to_le_bytes());
    Ok(())
}

pub fn pending_redeem_request(ctx: Context<PendingRedeemView>) -> Result<()> {
    let request = &ctx.accounts.redeem_request;
    let value = if request.status == RequestStatus::Pending {
        request.shares_locked
    } else {
        0
    };
    set_return_data(&value.to_le_bytes());
    Ok(())
}

pub fn claimable_redeem_request(ctx: Context<ClaimableRedeemView>) -> Result<()> {
    let escrow = &ctx.accounts.claimable_escrow;
    set_return_data(&escrow.amount.to_le_bytes());
    Ok(())
}
