use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface,
    TransferChecked,
};

use crate::{
    constants::*,
    error::VaultError,
    events::RedeemClaimed,
    state::{AsyncVault, ClaimableEscrow, OperatorApproval, RedeemRequest, RequestStatus},
};

use super::claim_deposit::validate_claim_authority;

#[derive(Accounts)]
pub struct ClaimRedeem<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), redeem_request.owner.as_ref()],
        bump = redeem_request.bump,
        close = rent_receiver,
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    #[account(
        mut,
        has_one = vault,
        has_one = owner,
        seeds = [CLAIMABLE_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = claimable_escrow.bump,
        close = rent_receiver,
    )]
    pub claimable_escrow: Account<'info, ClaimableEscrow>,

    /// CHECK: Validated via claimable_escrow.owner
    pub owner: UncheckedAccount<'info>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub claimable_tokens: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = receiver_asset_account.mint == vault.asset_mint,
        constraint = receiver_asset_account.owner == redeem_request.receiver @ VaultError::Unauthorized,
    )]
    pub receiver_asset_account: InterfaceAccount<'info, TokenAccount>,

    pub operator_approval: Option<Account<'info, OperatorApproval>>,

    /// CHECK: Receives rent from closed PDAs (must match redeem_request.owner)
    #[account(
        mut,
        constraint = rent_receiver.key() == redeem_request.owner @ VaultError::Unauthorized,
    )]
    pub rent_receiver: UncheckedAccount<'info>,

    pub asset_token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<ClaimRedeem>) -> Result<()> {
    let request = &ctx.accounts.redeem_request;

    require!(
        request.status == RequestStatus::Fulfilled,
        VaultError::RequestNotFulfilled
    );

    validate_claim_authority(
        &ctx.accounts.claimer,
        request.receiver,
        ctx.accounts.operator_approval.as_ref(),
        ctx.accounts.vault.key(),
        request.owner,
    )?;

    let assets = ctx.accounts.claimable_escrow.amount;

    let vault = &ctx.accounts.vault;
    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_signer_seeds: &[&[&[u8]]] = &[&[
        ASYNC_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[vault.bump],
    ]];

    // Transfer assets from claimable_tokens to receiver
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.claimable_tokens.to_account_info(),
                to: ctx.accounts.receiver_asset_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            vault_signer_seeds,
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    // Close claimable_tokens token account (rent to owner)
    close_account(CpiContext::new_with_signer(
        ctx.accounts.asset_token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.claimable_tokens.to_account_info(),
            destination: ctx.accounts.rent_receiver.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        vault_signer_seeds,
    ))?;

    // Mark request as claimed (PDA closed via `close = rent_receiver`)
    let request = &mut ctx.accounts.redeem_request;
    request.status = RequestStatus::Claimed;

    emit!(RedeemClaimed {
        vault: ctx.accounts.vault.key(),
        owner: request.owner,
        receiver: request.receiver,
        assets,
    });

    Ok(())
}
