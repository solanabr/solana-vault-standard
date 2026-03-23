//! Cancel redeem instruction: return locked shares to user, close redeem request.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, Token2022, TokenAccount, TransferChecked,
};

use crate::{
    constants::{REDEEM_REQUEST_SEED, SHARES_DECIMALS, SHARE_ESCROW_SEED, VAULT_SEED},
    error::VaultError,
    events::RedeemCancelled,
    state::{AsyncVault, RedeemRequest, RequestStatus},
};

#[derive(Accounts)]
pub struct CancelRedeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
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
        mut,
        close = user,
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), user.key().as_ref()],
        bump = redeem_request.bump,
        constraint = redeem_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
        constraint = redeem_request.owner == user.key() @ VaultError::InvalidRequestOwner,
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CancelRedeem>) -> Result<()> {
    let shares_to_return = ctx.accounts.redeem_request.shares_locked;

    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let vault_bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[vault_bump],
    ]];

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
        shares_to_return,
        SHARES_DECIMALS,
    )?;

    emit!(RedeemCancelled {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.user.key(),
        shares_returned: shares_to_return,
    });

    Ok(())
}
