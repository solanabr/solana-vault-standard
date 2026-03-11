use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};
use crate::{constants::*, error::VaultError, events::*, state::{CreditVault, FrozenAccount}};

#[derive(Accounts)]
pub struct Admin<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CREDIT_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, CreditVault>,
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
    emit!(AuthorityTransferred { vault: ctx.accounts.vault.key(), previous: prev, new_authority });
    Ok(())
}

pub fn set_manager(ctx: Context<Admin>, new_manager: Pubkey) -> Result<()> {
    let prev = ctx.accounts.vault.manager;
    ctx.accounts.vault.manager = new_manager;
    emit!(ManagerChanged { vault: ctx.accounts.vault.key(), previous: prev, new_manager });
    Ok(())
}

#[derive(Accounts)]
pub struct ManagerAdmin<'info> {
    pub manager: Signer<'info>,
    #[account(
        mut,
        seeds = [CREDIT_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = vault.manager == manager.key() @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, CreditVault>,
}

pub fn open_investment_window(ctx: Context<ManagerAdmin>) -> Result<()> {
    require!(!ctx.accounts.vault.window_open, VaultError::WindowAlreadyOpen);
    ctx.accounts.vault.window_open = true;
    emit!(InvestmentWindowOpened { vault: ctx.accounts.vault.key(), opened_at: Clock::get()?.unix_timestamp });
    Ok(())
}

pub fn close_investment_window(ctx: Context<ManagerAdmin>) -> Result<()> {
    require!(ctx.accounts.vault.window_open, VaultError::WindowNotOpen);
    ctx.accounts.vault.window_open = false;
    emit!(InvestmentWindowClosed { vault: ctx.accounts.vault.key(), closed_at: Clock::get()?.unix_timestamp });
    Ok(())
}

#[derive(Accounts)]
pub struct Repay<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        mut,
        seeds = [CREDIT_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = vault.manager == manager.key() @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, CreditVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault @ VaultError::InvalidAccount,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = manager_asset_account.owner == manager.key() @ VaultError::Unauthorized,
    )]
    pub manager_asset_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
}

pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);

    transfer_checked(
        CpiContext::new(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.manager_asset_account.to_account_info(),
                to: ctx.accounts.asset_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.manager.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.asset_mint.decimals,
    )?;

    ctx.accounts.vault.total_assets = ctx.accounts.vault.total_assets
        .checked_add(amount).ok_or(VaultError::MathOverflow)?;

    emit!(Repaid {
        vault: ctx.accounts.vault.key(),
        amount,
        new_total_assets: ctx.accounts.vault.total_assets,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Freeze<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        seeds = [CREDIT_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = vault.manager == manager.key() @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, CreditVault>,

    /// CHECK: the account to freeze — any pubkey
    pub target: UncheckedAccount<'info>,

    #[account(
        init, payer = manager,
        space = FrozenAccount::LEN,
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), target.key().as_ref()],
        bump,
    )]
    pub frozen_account: Account<'info, FrozenAccount>,

    pub system_program: Program<'info, System>,
}

pub fn freeze_account(ctx: Context<Freeze>) -> Result<()> {
    let target = ctx.accounts.target.key();
    let fa = &mut ctx.accounts.frozen_account;
    fa.vault = ctx.accounts.vault.key();
    fa.account = target;
    fa.frozen_at = Clock::get()?.unix_timestamp;
    fa.bump = ctx.bumps.frozen_account;
    emit!(AccountFrozen { vault: ctx.accounts.vault.key(), account: target });
    Ok(())
}

#[derive(Accounts)]
pub struct Unfreeze<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        seeds = [CREDIT_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = vault.manager == manager.key() @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, CreditVault>,

    /// CHECK: the account to unfreeze
    pub target: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), target.key().as_ref()],
        bump = frozen_account.bump,
        close = manager,
    )]
    pub frozen_account: Account<'info, FrozenAccount>,
}

pub fn unfreeze_account(ctx: Context<Unfreeze>) -> Result<()> {
    let target = ctx.accounts.target.key();
    emit!(AccountUnfrozen { vault: ctx.accounts.vault.key(), account: target });
    Ok(())
}
