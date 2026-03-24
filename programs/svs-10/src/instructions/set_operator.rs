use anchor_lang::prelude::*;

use crate::{
    constants::OPERATOR_APPROVAL_SEED,
    events::OperatorSet,
    state::{AsyncVault, OperatorApproval},
};

#[derive(Accounts)]
#[instruction(operator: Pubkey, can_fulfill_deposit: bool, can_fulfill_redeem: bool, can_claim: bool)]
pub struct ApproveOperator<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub vault: Account<'info, AsyncVault>,

    #[account(
        init,
        payer = owner,
        space = OperatorApproval::LEN,
        seeds = [OPERATOR_APPROVAL_SEED, vault.key().as_ref(), owner.key().as_ref(), operator.as_ref()],
        bump,
    )]
    pub operator_approval: Account<'info, OperatorApproval>,

    pub system_program: Program<'info, System>,
}

pub fn approve_operator(
    ctx: Context<ApproveOperator>,
    operator: Pubkey,
    can_fulfill_deposit: bool,
    can_fulfill_redeem: bool,
    can_claim: bool,
) -> Result<()> {
    let approval = &mut ctx.accounts.operator_approval;
    approval.owner = ctx.accounts.owner.key();
    approval.operator = operator;
    approval.vault = ctx.accounts.vault.key();
    approval.can_fulfill_deposit = can_fulfill_deposit;
    approval.can_fulfill_redeem = can_fulfill_redeem;
    approval.can_claim = can_claim;
    approval.bump = ctx.bumps.operator_approval;

    emit!(OperatorSet {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.owner.key(),
        operator,
        approved: true,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(operator: Pubkey)]
pub struct UpdateOperator<'info> {
    pub owner: Signer<'info>,

    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        has_one = owner,
        seeds = [OPERATOR_APPROVAL_SEED, vault.key().as_ref(), owner.key().as_ref(), operator.as_ref()],
        bump = operator_approval.bump,
    )]
    pub operator_approval: Account<'info, OperatorApproval>,
}

pub fn update_operator(
    ctx: Context<UpdateOperator>,
    _operator: Pubkey,
    can_fulfill_deposit: bool,
    can_fulfill_redeem: bool,
    can_claim: bool,
) -> Result<()> {
    let approval = &mut ctx.accounts.operator_approval;
    approval.can_fulfill_deposit = can_fulfill_deposit;
    approval.can_fulfill_redeem = can_fulfill_redeem;
    approval.can_claim = can_claim;

    emit!(OperatorSet {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.owner.key(),
        operator: approval.operator,
        approved: true,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(operator: Pubkey)]
pub struct RevokeOperator<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        close = owner,
        has_one = owner,
        seeds = [OPERATOR_APPROVAL_SEED, vault.key().as_ref(), owner.key().as_ref(), operator.as_ref()],
        bump = operator_approval.bump,
    )]
    pub operator_approval: Account<'info, OperatorApproval>,
}

pub fn revoke_operator(ctx: Context<RevokeOperator>, operator: Pubkey) -> Result<()> {
    emit!(OperatorSet {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.owner.key(),
        operator,
        approved: false,
    });

    Ok(())
}
