use crate::{
    error::VaultError,
    events::{AuthorityTransferred, VaultStatusChanged},
    state::MultiAssetVault,
};
use anchor_lang::prelude::*;

pub fn pause(ctx: Context<Admin>) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    ctx.accounts.vault.paused = true;
    emit!(VaultStatusChanged {
        vault: ctx.accounts.vault.key(),
        paused: true,
    });
    Ok(())
}

pub fn unpause(ctx: Context<Admin>) -> Result<()> {
    require!(ctx.accounts.vault.paused, VaultError::VaultNotPaused);
    ctx.accounts.vault.paused = false;
    emit!(VaultStatusChanged {
        vault: ctx.accounts.vault.key(),
        paused: false,
    });
    Ok(())
}

// TODO(M-8): Implement two-step authority transfer (request_transfer_authority + accept_authority)
//            matching the pattern in SVS-1 and SVS-2.
pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
    require!(new_authority != Pubkey::default(), VaultError::Unauthorized);
    let previous = ctx.accounts.vault.authority;
    ctx.accounts.vault.authority = new_authority;
    emit!(AuthorityTransferred {
        vault: ctx.accounts.vault.key(),
        previous_authority: previous,
        new_authority,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(mut, has_one = authority)]
    pub vault: Account<'info, MultiAssetVault>,
    pub authority: Signer<'info>,
}
