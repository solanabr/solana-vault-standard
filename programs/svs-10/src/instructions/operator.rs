//! Operator instructions: set_operator (per-user approval), set_vault_operator.

use anchor_lang::prelude::*;

use crate::{
    constants::{ASYNC_VAULT_SEED, OPERATOR_APPROVAL_SEED},
    error::VaultError,
    events::{OperatorSet, VaultOperatorChanged},
    state::{AsyncVault, OperatorApproval},
};

// =============================================================================
// set_operator: User grants/revokes per-user operator approval
// =============================================================================

#[derive(Accounts)]
pub struct SetOperator<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    pub vault: Account<'info, AsyncVault>,

    #[account(
        init_if_needed,
        payer = owner,
        space = OperatorApproval::LEN,
        seeds = [
            OPERATOR_APPROVAL_SEED,
            vault.key().as_ref(),
            owner.key().as_ref(),
            operator.key().as_ref(),
        ],
        bump
    )]
    pub operator_approval: Account<'info, OperatorApproval>,

    /// CHECK: the pubkey being approved as an operator
    pub operator: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn set_operator_handler(ctx: Context<SetOperator>, approved: bool) -> Result<()> {
    let approval = &mut ctx.accounts.operator_approval;
    let vault_key = ctx.accounts.vault.key();
    let owner_key = ctx.accounts.owner.key();
    let operator_key = ctx.accounts.operator.key();

    // Initialize fields on first creation
    if approval.vault == Pubkey::default() {
        approval.vault = vault_key;
        approval.owner = owner_key;
        approval.operator = operator_key;
        approval.bump = ctx.bumps.operator_approval;
    }

    approval.approved = approved;

    emit!(OperatorSet {
        vault: vault_key,
        owner: owner_key,
        operator: operator_key,
        approved,
    });

    Ok(())
}

// =============================================================================
// set_vault_operator: Authority changes the vault-level operator
// =============================================================================

#[derive(Accounts)]
pub struct SetVaultOperator<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ASYNC_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AsyncVault>,

    /// CHECK: new operator pubkey
    pub new_operator: UncheckedAccount<'info>,
}

pub fn set_vault_operator_handler(ctx: Context<SetVaultOperator>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let previous_operator = vault.operator;
    let new_operator = ctx.accounts.new_operator.key();

    vault.operator = new_operator;

    emit!(VaultOperatorChanged {
        vault: vault.key(),
        previous_operator,
        new_operator,
    });

    Ok(())
}
