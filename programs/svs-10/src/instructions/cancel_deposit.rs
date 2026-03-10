use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::*,
    error::VaultError,
    events::DepositCancelled,
    state::{AsyncVault, DepositRequest, RequestStatus},
};

#[derive(Accounts)]
pub struct CancelDeposit<'info> {
    pub owner: Signer<'info>,

    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        has_one = vault,
        has_one = owner,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = deposit_request.bump,
        close = owner,
    )]
    pub deposit_request: Account<'info, DepositRequest>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_asset_account.mint == vault.asset_mint,
        constraint = user_asset_account.owner == owner.key(),
    )]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<CancelDeposit>) -> Result<()> {
    let request = &ctx.accounts.deposit_request;

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

    let assets_to_return = request.assets_locked;

    let vault = &ctx.accounts.vault;
    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[
        ASYNC_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[vault.bump],
    ]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.asset_vault.to_account_info(),
                to: ctx.accounts.user_asset_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        assets_to_return,
        ctx.accounts.asset_mint.decimals,
    )?;

    emit!(DepositCancelled {
        vault: vault.key(),
        owner: ctx.accounts.owner.key(),
        assets_returned: assets_to_return,
    });

    Ok(())
}
