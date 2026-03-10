use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    error::VaultError,
    events::RedeemCancelled,
    state::{AsyncVault, RedeemRequest, RequestStatus},
};

#[derive(Accounts)]
pub struct CancelRedeem<'info> {
    pub owner: Signer<'info>,

    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        has_one = vault,
        has_one = owner,
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = redeem_request.bump,
        close = owner,
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = share_escrow.key() == vault.share_escrow,
    )]
    pub share_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == owner.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handler(ctx: Context<CancelRedeem>) -> Result<()> {
    let request = &ctx.accounts.redeem_request;

    require!(
        request.status == RequestStatus::Pending,
        VaultError::RequestNotPending
    );

    // Bug #5: Enforce cancel delay
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= request.cancel_not_before,
        VaultError::CancelTooEarly
    );

    let shares_to_return = request.shares_locked;

    let vault = &ctx.accounts.vault;
    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[
        ASYNC_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[vault.bump],
    ]];

    // Return shares from escrow to user
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
        vault: vault.key(),
        owner: ctx.accounts.owner.key(),
        shares_returned: shares_to_return,
    });

    Ok(())
}
