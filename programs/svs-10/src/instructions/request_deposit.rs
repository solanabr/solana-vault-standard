use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::*,
    error::VaultError,
    events::DepositRequested,
    state::{AsyncVault, DepositRequest, RequestStatus},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct RequestDeposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        init,
        payer = user,
        space = DepositRequest::LEN,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub deposit_request: Account<'info, DepositRequest>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_asset_account.mint == vault.asset_mint,
        constraint = user_asset_account.owner == user.key(),
    )]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RequestDeposit>, assets: u64, receiver: Pubkey) -> Result<()> {
    require!(assets > 0, VaultError::ZeroAmount);

    #[cfg(feature = "modules")]
    {
        let remaining = ctx.remaining_accounts;
        let vault_key = ctx.accounts.vault.key();
        let user_key = ctx.accounts.user.key();
        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;
    }

    let clock = Clock::get()?;

    // Bug #3: Delta-based accounting for T22 transfer fees
    let before = ctx.accounts.asset_vault.amount;

    transfer_checked(
        CpiContext::new(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_asset_account.to_account_info(),
                to: ctx.accounts.asset_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    ctx.accounts.asset_vault.reload()?;
    let actual = ctx
        .accounts
        .asset_vault
        .amount
        .checked_sub(before)
        .ok_or(VaultError::MathOverflow)?;

    let vault = &ctx.accounts.vault;
    let request = &mut ctx.accounts.deposit_request;
    request.vault = vault.key();
    request.owner = ctx.accounts.user.key();
    request.receiver = receiver;
    request.assets_locked = actual;
    request.shares_claimable = 0;
    request.status = RequestStatus::Pending;
    request.requested_at = clock.unix_timestamp;
    request.fulfilled_at = 0;
    request.cancel_not_before = clock
        .unix_timestamp
        .checked_add(vault.cancel_delay)
        .ok_or(VaultError::MathOverflow)?;
    request.bump = ctx.bumps.deposit_request;

    emit!(DepositRequested {
        vault: vault.key(),
        owner: request.owner,
        receiver: request.receiver,
        assets: actual,
    });

    Ok(())
}
