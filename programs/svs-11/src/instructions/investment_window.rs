use anchor_lang::prelude::*;

use crate::{
    error::VaultError,
    events::{WindowClosed, WindowOpened},
    state::CreditVault,
};

#[derive(Accounts)]
pub struct InvestmentWindow<'info> {
    #[account(
        constraint = manager.key() == vault.manager @ VaultError::Unauthorized,
    )]
    pub manager: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, CreditVault>,
}

pub fn open_investment_window(ctx: Context<InvestmentWindow>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    vault.investment_window_open = true;

    emit!(WindowOpened { vault: vault.key() });

    Ok(())
}

pub fn close_investment_window(ctx: Context<InvestmentWindow>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    vault.investment_window_open = false;

    emit!(WindowClosed { vault: vault.key() });

    Ok(())
}
