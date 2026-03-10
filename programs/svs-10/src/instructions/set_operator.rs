//! Set operator approval instruction.

use anchor_lang::prelude::*;

use crate::{
    constants::OPERATOR_APPROVAL_SEED,
    events::OperatorSet,
    state::{AsyncVault, OperatorApproval},
};

#[derive(Accounts)]
#[instruction(operator: Pubkey, can_fulfill_deposit: bool, can_fulfill_redeem: bool, can_claim: bool)]
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

pub fn handler(
    ctx: Context<SetOperator>,
    operator: Pubkey,
    can_fulfill_deposit: bool,
    can_fulfill_redeem: bool,
    can_claim: bool,
) -> Result<()> {
    let any_approved = can_fulfill_deposit || can_fulfill_redeem || can_claim;

    if any_approved {
        let approval = &mut ctx.accounts.operator_approval;
        approval.owner = ctx.accounts.owner.key();
        approval.operator = operator;
        approval.vault = ctx.accounts.vault.key();
        approval.can_fulfill_deposit = can_fulfill_deposit;
        approval.can_fulfill_redeem = can_fulfill_redeem;
        approval.can_claim = can_claim;
        approval.bump = ctx.bumps.operator_approval;
    } else {
        // Close the PDA to recover rent when revoking all permissions
        ctx.accounts
            .operator_approval
            .close(ctx.accounts.owner.to_account_info())?;
    }

    emit!(OperatorSet {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.owner.key(),
        operator,
        approved: any_approved,
    });

    Ok(())
}
