use anchor_lang::prelude::*;

use crate::{
    constants::FROZEN_ACCOUNT_SEED,
    error::VaultError,
    events::{AccountFrozenEvent, AccountUnfrozenEvent},
    state::{CreditVault, FrozenAccount},
};

#[derive(Accounts)]
pub struct FreezeAccount<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        constraint = vault.manager == manager.key() @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, CreditVault>,

    /// CHECK: Investor whose account is being frozen
    pub investor: UncheckedAccount<'info>,

    #[account(
        init,
        payer = manager,
        space = FrozenAccount::LEN,
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump
    )]
    pub frozen_account: Account<'info, FrozenAccount>,

    pub system_program: Program<'info, System>,
}

pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
    let clock = Clock::get()?;

    let frozen = &mut ctx.accounts.frozen_account;
    frozen.vault = ctx.accounts.vault.key();
    frozen.investor = ctx.accounts.investor.key();
    frozen.frozen_by = ctx.accounts.manager.key();
    frozen.frozen_at = clock.unix_timestamp;
    frozen.bump = ctx.bumps.frozen_account;

    emit!(AccountFrozenEvent {
        vault: ctx.accounts.vault.key(),
        investor: ctx.accounts.investor.key(),
        frozen_by: ctx.accounts.manager.key(),
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UnfreezeAccount<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        constraint = vault.manager == manager.key() @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, CreditVault>,

    /// CHECK: Investor whose account is being unfrozen
    pub investor: UncheckedAccount<'info>,

    #[account(
        mut,
        has_one = vault,
        has_one = investor,
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump = frozen_account.bump,
        close = manager,
    )]
    pub frozen_account: Account<'info, FrozenAccount>,
}

pub fn unfreeze_account(ctx: Context<UnfreezeAccount>) -> Result<()> {
    emit!(AccountUnfrozenEvent {
        vault: ctx.accounts.vault.key(),
        investor: ctx.accounts.investor.key(),
    });

    Ok(())
}
