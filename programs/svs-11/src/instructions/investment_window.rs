use anchor_lang::prelude::*;

use crate::constants::VAULT_SEED;
use crate::error::VaultError;
use crate::events::{WindowClosed, WindowOpened};
use crate::state::CreditVault;

#[derive(Accounts)]
pub struct InvestmentWindow<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = manager,
    )]
    pub vault: Account<'info, CreditVault>,
    pub manager: Signer<'info>,
}

pub fn open_handler(ctx: Context<InvestmentWindow>) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(
        !ctx.accounts.vault.investment_window_open,
        VaultError::InvestmentWindowAlreadyOpen
    );
    ctx.accounts.vault.investment_window_open = true;
    emit!(WindowOpened {
        vault: ctx.accounts.vault.key()
    });
    Ok(())
}

pub fn close_handler(ctx: Context<InvestmentWindow>) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(
        ctx.accounts.vault.investment_window_open,
        VaultError::InvestmentWindowClosed
    );
    ctx.accounts.vault.investment_window_open = false;
    emit!(WindowClosed {
        vault: ctx.accounts.vault.key()
    });
    Ok(())
}
