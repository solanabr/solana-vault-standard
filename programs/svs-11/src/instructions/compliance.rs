use anchor_lang::prelude::*;

use crate::constants::{FROZEN_ACCOUNT_SEED, VAULT_SEED};
use crate::events::{AccountFrozen as AccountFrozenEvent, AccountUnfrozen};
use crate::state::{CreditVault, FrozenAccount};

#[derive(Accounts)]
pub struct FreezeAccount<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = manager,
    )]
    pub vault: Account<'info, CreditVault>,

    /// CHECK: investor to freeze
    pub investor: UncheckedAccount<'info>,

    #[account(
        init,
        payer = manager,
        space = FrozenAccount::LEN,
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub frozen_account: Account<'info, FrozenAccount>,

    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

pub fn freeze_handler(ctx: Context<FreezeAccount>) -> Result<()> {
    let frozen = &mut ctx.accounts.frozen_account;
    frozen.investor = ctx.accounts.investor.key();
    frozen.vault = ctx.accounts.vault.key();
    frozen.frozen_by = ctx.accounts.manager.key();
    frozen.frozen_at = ctx.accounts.clock.unix_timestamp;
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
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = manager,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        mut,
        close = manager,
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), frozen_account.investor.as_ref()],
        bump = frozen_account.bump,
    )]
    pub frozen_account: Account<'info, FrozenAccount>,
}

pub fn unfreeze_handler(ctx: Context<UnfreezeAccount>) -> Result<()> {
    emit!(AccountUnfrozen {
        vault: ctx.accounts.vault.key(),
        investor: ctx.accounts.frozen_account.investor,
    });

    Ok(())
}
