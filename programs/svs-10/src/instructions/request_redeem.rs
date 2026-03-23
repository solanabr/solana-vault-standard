//! Request redeem instruction: lock shares in escrow, create pending redeem request.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, Token2022, TokenAccount, TransferChecked,
};

use crate::{
    constants::{REDEEM_REQUEST_SEED, SHARES_DECIMALS, SHARE_ESCROW_SEED},
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
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, AsyncVault>,

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
        seeds = [SHARE_ESCROW_SEED, vault.key().as_ref()],
        bump = vault.share_escrow_bump,
    )]
    pub share_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = user,
        space = RedeemRequest::LEN,
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RequestRedeem>, shares: u64, receiver: Pubkey) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);

    #[cfg(feature = "modules")]
    {
        let vault = &ctx.accounts.vault;
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let user_key = ctx.accounts.user.key();

        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;

        let current_timestamp = Clock::get()?.unix_timestamp;
        module_hooks::check_share_lock(
            remaining,
            &crate::ID,
            &vault_key,
            &user_key,
            current_timestamp,
        )?;
    }

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

    let redeem_request = &mut ctx.accounts.redeem_request;
    redeem_request.owner = ctx.accounts.user.key();
    redeem_request.receiver = receiver;
    redeem_request.vault = ctx.accounts.vault.key();
    redeem_request.shares_locked = shares;
    redeem_request.assets_claimable = 0;
    redeem_request.status = RequestStatus::Pending;
    redeem_request.requested_at = Clock::get()?.unix_timestamp;
    redeem_request.fulfilled_at = 0;
    redeem_request.bump = ctx.bumps.redeem_request;

    emit!(RedeemRequested {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.user.key(),
        receiver,
        shares,
    });

    Ok(())
}
