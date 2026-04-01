use anchor_lang::prelude::*;

use crate::constants::{FROZEN_ACCOUNT_SEED, VAULT_CONFIG_SEED, VAULT_SEED};
use crate::error::VaultError;
use crate::events::{AccountFrozen as AccountFrozenEvent, AccountUnfrozen};
use crate::state::{CreditVault, FrozenAccount, VaultConfig};

/// Validates that the caller is authorized to perform compliance actions.
/// Authorized callers: vault authority, vault manager, or compliance officer.
fn is_authorized_compliance_caller(
    caller: &Pubkey,
    vault: &CreditVault,
    vault_config: &VaultConfig,
) -> bool {
    *caller == vault.authority
        || *caller == vault.manager
        || (vault_config.compliance_officer != Pubkey::default()
            && *caller == vault_config.compliance_officer)
}

#[derive(Accounts)]
pub struct FreezeAccount<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        has_one = vault,
        seeds = [VAULT_CONFIG_SEED, vault.key().as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    /// CHECK: investor to freeze
    pub investor: UncheckedAccount<'info>,

    #[account(
        init,
        payer = caller,
        space = FrozenAccount::LEN,
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub frozen_account: Account<'info, FrozenAccount>,

    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

pub fn freeze_handler(ctx: Context<FreezeAccount>) -> Result<()> {
    require!(
        is_authorized_compliance_caller(
            &ctx.accounts.caller.key(),
            &ctx.accounts.vault,
            &ctx.accounts.vault_config,
        ),
        VaultError::UnauthorizedComplianceAction
    );

    let frozen = &mut ctx.accounts.frozen_account;
    frozen.investor = ctx.accounts.investor.key();
    frozen.vault = ctx.accounts.vault.key();
    frozen.frozen_by = ctx.accounts.caller.key();
    frozen.frozen_at = ctx.accounts.clock.unix_timestamp;
    frozen.bump = ctx.bumps.frozen_account;

    emit!(AccountFrozenEvent {
        vault: ctx.accounts.vault.key(),
        investor: ctx.accounts.investor.key(),
        frozen_by: ctx.accounts.caller.key(),
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UnfreezeAccount<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        has_one = vault,
        seeds = [VAULT_CONFIG_SEED, vault.key().as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        mut,
        close = caller,
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), frozen_account.investor.as_ref()],
        bump = frozen_account.bump,
    )]
    pub frozen_account: Account<'info, FrozenAccount>,
}

pub fn unfreeze_handler(ctx: Context<UnfreezeAccount>) -> Result<()> {
    require!(
        is_authorized_compliance_caller(
            &ctx.accounts.caller.key(),
            &ctx.accounts.vault,
            &ctx.accounts.vault_config,
        ),
        VaultError::UnauthorizedComplianceAction
    );

    emit!(AccountUnfrozen {
        vault: ctx.accounts.vault.key(),
        investor: ctx.accounts.frozen_account.investor,
    });

    Ok(())
}
