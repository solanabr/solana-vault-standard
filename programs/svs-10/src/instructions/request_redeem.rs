//! request_redeem: Lock shares in escrow, create RedeemRequest PDA.

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::Token2022,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::{ASYNC_VAULT_SEED, REDEEM_REQUEST_SEED, SHARE_ESCROW_SEED},
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
        seeds = [ASYNC_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        constraint = shares_mint.key() == vault.shares_mint @ VaultError::Unauthorized,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint @ VaultError::Unauthorized,
        constraint = user_shares_account.owner == user.key() @ VaultError::Unauthorized,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// Share escrow: PDA-owned token account for locked shares during pending redemption
    #[account(
        mut,
        seeds = [SHARE_ESCROW_SEED, vault.key().as_ref()],
        bump,
        constraint = share_escrow.key() == vault.share_escrow @ VaultError::Unauthorized,
    )]
    pub share_escrow: InterfaceAccount<'info, TokenAccount>,

    /// RedeemRequest PDA — one per user per vault (init enforces uniqueness)
    #[account(
        init,
        payer = user,
        space = RedeemRequest::LEN,
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    pub token_2022_program: Program<'info, Token2022>,
    pub asset_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RequestRedeem>, shares: u64, receiver: Pubkey) -> Result<()> {
    // 1. VALIDATION
    require!(shares > 0, VaultError::ZeroAmount);

    let vault = &ctx.accounts.vault;
    let vault_key = vault.key();
    let user_key = ctx.accounts.user.key();

    // 2. MODULE HOOKS: access control and lock checks
    #[cfg(feature = "modules")]
    {
        let remaining = ctx.remaining_accounts;
        // Access control check
        module_hooks::check_redeem_access(remaining, &crate::ID, &vault_key, &user_key)?;
        // Lock check (must not be locked)
        module_hooks::check_share_lock(remaining, &crate::ID, &vault_key, &user_key)?;
    }

    // 3. TRANSFER SHARES from user to share_escrow (vault PDA is authority)
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
        crate::constants::SHARES_DECIMALS,
    )?;

    // 4. CREATE REDEEM REQUEST PDA
    let clock = Clock::get()?;
    let redeem_request = &mut ctx.accounts.redeem_request;
    redeem_request.vault = vault_key;
    redeem_request.owner = user_key;
    redeem_request.receiver = receiver;
    redeem_request.shares_locked = shares;
    redeem_request.assets_claimable = 0;
    redeem_request.status = RequestStatus::Pending;
    redeem_request.requested_at = clock.unix_timestamp;
    redeem_request.fulfilled_at = 0;
    redeem_request.bump = ctx.bumps.redeem_request;

    // 5. EMIT EVENT
    emit!(RedeemRequested {
        vault: vault_key,
        owner: user_key,
        receiver,
        shares,
    });

    Ok(())
}
