use anchor_lang::prelude::*;

use crate::{
    constants::OPERATOR_APPROVAL_SEED,
    events::OperatorSet,
    state::{AsyncVault, OperatorApproval},
};

#[derive(Accounts)]
pub struct ApproveOperator<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub vault: Account<'info, AsyncVault>,

    /// CHECK: The operator being approved
    pub operator: UncheckedAccount<'info>,

    #[account(
        init,
        payer = owner,
        space = OperatorApproval::LEN,
        seeds = [OPERATOR_APPROVAL_SEED, vault.key().as_ref(), owner.key().as_ref(), operator.key().as_ref()],
        bump
    )]
    pub operator_approval: Account<'info, OperatorApproval>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ApproveOperator>, can_claim: bool) -> Result<()> {
    let approval = &mut ctx.accounts.operator_approval;
    approval.vault = ctx.accounts.vault.key();
    approval.owner = ctx.accounts.owner.key();
    approval.operator = ctx.accounts.operator.key();
    approval.can_claim = can_claim;
    approval.bump = ctx.bumps.operator_approval;

    emit!(OperatorSet {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.owner.key(),
        operator: ctx.accounts.operator.key(),
        can_claim,
    });

    Ok(())
}
