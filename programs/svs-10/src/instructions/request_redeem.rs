use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    error::VaultError,
    events::RedeemRequested,
    state::{AsyncVault, RedeemRequest, RequestStatus},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct RequestRedeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        init,
        payer = user,
        space = RedeemRequest::LEN,
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = share_escrow.key() == vault.share_escrow,
    )]
    pub share_escrow: InterfaceAccount<'info, TokenAccount>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RequestRedeem>, shares: u64, receiver: Pubkey) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);

    require!(
        ctx.accounts.user_shares_account.amount >= shares,
        VaultError::InsufficientShares
    );

    #[cfg(feature = "modules")]
    {
        let remaining = ctx.remaining_accounts;
        let vault_key = ctx.accounts.vault.key();
        let user_key = ctx.accounts.user.key();
        let clock = Clock::get()?;
        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;
        module_hooks::check_share_lock(
            remaining,
            &crate::ID,
            &vault_key,
            &user_key,
            clock.unix_timestamp,
        )?;
    }

    let clock = Clock::get()?;

    // Transfer shares to escrow
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_2022_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_shares_account.to_account_info(),
                to: ctx.accounts.share_escrow.to_account_info(),
                mint: ctx.accounts.shares_mint.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
        SHARES_DECIMALS,
    )?;

    let vault = &ctx.accounts.vault;
    let request = &mut ctx.accounts.redeem_request;
    request.vault = vault.key();
    request.owner = ctx.accounts.user.key();
    request.receiver = receiver;
    request.shares_locked = shares;
    request.assets_claimable = 0;
    request.status = RequestStatus::Pending;
    request.requested_at = clock.unix_timestamp;
    request.fulfilled_at = 0;
    request.cancel_not_before = clock
        .unix_timestamp
        .checked_add(vault.cancel_delay)
        .ok_or(VaultError::MathOverflow)?;
    request.bump = ctx.bumps.redeem_request;

    emit!(RedeemRequested {
        vault: vault.key(),
        owner: request.owner,
        receiver: request.receiver,
        shares,
    });

    Ok(())
}
