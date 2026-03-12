use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface,
    TransferChecked,
};

use crate::{
    constants::*,
    error::VaultError,
    events::RedemptionClaimed,
    state::{ClaimableEscrow, CreditVault, RedemptionRequest, RedemptionStatus},
};

#[derive(Accounts)]
pub struct ClaimRedemption<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,

    pub vault: Account<'info, CreditVault>,

    #[account(
        mut,
        has_one = vault,
        constraint = redemption_request.investor == investor.key() @ VaultError::Unauthorized,
        seeds = [REDEMPTION_REQUEST_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump = redemption_request.bump,
        close = investor,
    )]
    pub redemption_request: Account<'info, RedemptionRequest>,

    #[account(
        mut,
        has_one = vault,
        constraint = claimable_escrow.investor == investor.key() @ VaultError::Unauthorized,
        seeds = [CLAIMABLE_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump = claimable_escrow.bump,
        close = investor,
    )]
    pub claimable_escrow: Account<'info, ClaimableEscrow>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump
    )]
    pub claimable_tokens: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = investor_asset_account.mint == vault.asset_mint,
        constraint = investor_asset_account.owner == investor.key(),
    )]
    pub investor_asset_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<ClaimRedemption>) -> Result<()> {
    // Spec: No attestation check, no freeze check at claim time
    let request = &ctx.accounts.redemption_request;

    require!(
        request.status == RedemptionStatus::Approved,
        VaultError::RequestNotPending
    );

    let assets = ctx.accounts.claimable_escrow.amount_claimable;

    let vault = &ctx.accounts.vault;
    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_signer_seeds: &[&[&[u8]]] = &[&[
        CREDIT_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[vault.bump],
    ]];

    // Transfer assets from claimable_tokens to investor
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.claimable_tokens.to_account_info(),
                to: ctx.accounts.investor_asset_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            vault_signer_seeds,
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    // Close claimable_tokens token account (rent to investor)
    close_account(CpiContext::new_with_signer(
        ctx.accounts.asset_token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.claimable_tokens.to_account_info(),
            destination: ctx.accounts.investor.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        vault_signer_seeds,
    ))?;

    emit!(RedemptionClaimed {
        vault: vault.key(),
        investor: ctx.accounts.investor.key(),
        assets,
    });

    Ok(())
}
