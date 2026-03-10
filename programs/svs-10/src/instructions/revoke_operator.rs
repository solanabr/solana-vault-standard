use anchor_lang::prelude::*;

use crate::{
    constants::OPERATOR_APPROVAL_SEED,
    events::OperatorRevoked,
    state::{AsyncVault, OperatorApproval},
};

#[derive(Accounts)]
pub struct RevokeOperator<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub vault: Account<'info, AsyncVault>,

    /// CHECK: The operator being revoked
    pub operator: UncheckedAccount<'info>,

    #[account(
        mut,
        has_one = vault,
        has_one = owner,
        has_one = operator,
        seeds = [OPERATOR_APPROVAL_SEED, vault.key().as_ref(), owner.key().as_ref(), operator.key().as_ref()],
        bump = operator_approval.bump,
        close = owner,
    )]
    pub operator_approval: Account<'info, OperatorApproval>,
}

pub fn handler(ctx: Context<RevokeOperator>) -> Result<()> {
    emit!(OperatorRevoked {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.owner.key(),
        operator: ctx.accounts.operator.key(),
    });

    Ok(())
}
