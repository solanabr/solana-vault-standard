//! Set operator approval instruction.

use anchor_lang::prelude::*;

use crate::{
    constants::OPERATOR_APPROVAL_SEED,
    events::OperatorSet,
    state::{AsyncVault, OperatorApproval},
};

#[derive(Accounts)]
#[instruction(operator: Pubkey, approved: bool)]
pub struct SetOperator<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub vault: Account<'info, AsyncVault>,

    #[account(
        init_if_needed,
        payer = owner,
        space = OperatorApproval::LEN,
        seeds = [OPERATOR_APPROVAL_SEED, vault.key().as_ref(), owner.key().as_ref(), operator.as_ref()],
        bump,
    )]
    pub operator_approval: Account<'info, OperatorApproval>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SetOperator>, operator: Pubkey, approved: bool) -> Result<()> {
    let approval = &mut ctx.accounts.operator_approval;
    approval.owner = ctx.accounts.owner.key();
    approval.operator = operator;
    approval.vault = ctx.accounts.vault.key();
    approval.approved = approved;
    approval.bump = ctx.bumps.operator_approval;

    emit!(OperatorSet {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.owner.key(),
        operator,
        approved,
    });

    Ok(())
}
