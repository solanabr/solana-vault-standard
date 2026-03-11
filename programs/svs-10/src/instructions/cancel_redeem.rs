//! cancel_redeem: Cancel pending redeem request, return shares to user.

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::Token2022,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::{ASYNC_VAULT_SEED, REDEEM_REQUEST_SEED, SHARE_ESCROW_SEED},
    error::VaultError,
    events::RedeemRequestCancelled,
    state::{AsyncVault, RedeemRequest, RequestStatus},
};

#[derive(Accounts)]
pub struct CancelRedeem<'info> {
    /// Request owner — must be signer and match redeem_request.owner
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [ASYNC_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = redeem_request.bump,
        has_one = vault @ VaultError::Unauthorized,
        has_one = owner @ VaultError::Unauthorized,
        close = owner,
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    #[account(
        constraint = shares_mint.key() == vault.shares_mint @ VaultError::Unauthorized,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    /// Share escrow — locked shares are returned from here
    #[account(
        mut,
        seeds = [SHARE_ESCROW_SEED, vault.key().as_ref()],
        bump,
        constraint = share_escrow.key() == vault.share_escrow @ VaultError::Unauthorized,
    )]
    pub share_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint @ VaultError::Unauthorized,
        constraint = user_shares_account.owner == owner.key() @ VaultError::Unauthorized,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_2022_program: Program<'info, Token2022>,
    pub asset_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CancelRedeem>) -> Result<()> {
    // 1. VALIDATION: request must be Pending
    require!(
        ctx.accounts.redeem_request.status == RequestStatus::Pending,
        VaultError::RequestNotPending
    );

    let shares_locked = ctx.accounts.redeem_request.shares_locked;
    let vault = &ctx.accounts.vault;
    let vault_key = vault.key();
    let owner_key = ctx.accounts.owner.key();

    // 2. BUILD VAULT PDA SIGNER SEEDS
    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        ASYNC_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    // 3. RETURN SHARES from share_escrow to user
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.share_escrow.to_account_info(),
                to: ctx.accounts.user_shares_account.to_account_info(),
                mint: ctx.accounts.shares_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares_locked,
        crate::constants::SHARES_DECIMALS,
    )?;

    // 4. CLOSE REDEEM REQUEST PDA (done via `close = owner` constraint)

    // 5. EMIT EVENT
    emit!(RedeemRequestCancelled {
        vault: vault_key,
        owner: owner_key,
        shares_returned: shares_locked,
    });

    Ok(())
}
