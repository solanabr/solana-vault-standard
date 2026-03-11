use anchor_lang::prelude::*;
use crate::{constants::*, error::VaultError, events::*, state::AsyncVault};

#[derive(Accounts)]
pub struct Admin<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [ASYNC_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, AsyncVault>,
}

pub fn pause(ctx: Context<Admin>) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    ctx.accounts.vault.paused = true;
    emit!(VaultStatusChanged { vault: ctx.accounts.vault.key(), paused: true });
    Ok(())
}

pub fn unpause(ctx: Context<Admin>) -> Result<()> {
    require!(ctx.accounts.vault.paused, VaultError::VaultNotPaused);
    ctx.accounts.vault.paused = false;
    emit!(VaultStatusChanged { vault: ctx.accounts.vault.key(), paused: false });
    Ok(())
}

pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
    let prev = ctx.accounts.vault.authority;
    ctx.accounts.vault.authority = new_authority;
    emit!(AuthorityTransferred { vault: ctx.accounts.vault.key(), previous_authority: prev, new_authority });
    Ok(())
}

pub fn set_vault_operator(ctx: Context<Admin>, new_operator: Pubkey) -> Result<()> {
    let prev = ctx.accounts.vault.operator;
    ctx.accounts.vault.operator = new_operator;
    emit!(VaultOperatorChanged { vault: ctx.accounts.vault.key(), previous_operator: prev, new_operator });
    Ok(())
}
