//! Claim redeem instruction: transfer assets to receiver, close claimable account and request PDA.
//!
//! After the operator fulfills a redeem, the receiver (or an approved operator)
//! claims the computed assets from the claimable_tokens account.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::{CLAIMABLE_TOKENS_SEED, REDEEM_REQUEST_SEED, VAULT_SEED},
    error::VaultError,
    events::RedeemClaimed,
    state::{AsyncVault, OperatorApproval, RedeemRequest, RequestStatus},
};

#[derive(Accounts)]
pub struct ClaimRedeem<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        close = owner,
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), redeem_request.owner.as_ref()],
        bump = redeem_request.bump,
        constraint = redeem_request.status == RequestStatus::Fulfilled @ VaultError::RequestNotFulfilled,
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    /// CHECK: Owner receives rent refund on close
    #[account(mut)]
    pub owner: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), redeem_request.owner.as_ref()],
        bump,
    )]
    pub claimable_tokens: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = receiver_asset_account.mint == vault.asset_mint,
        constraint = receiver_asset_account.owner == receiver.key(),
    )]
    pub receiver_asset_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Receiver derived from redeem_request
    pub receiver: SystemAccount<'info>,

    pub operator_approval: Option<Account<'info, OperatorApproval>>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimRedeem>) -> Result<()> {
    let redeem_request = &ctx.accounts.redeem_request;

    let is_receiver = ctx.accounts.claimant.key() == redeem_request.receiver;
    if !is_receiver {
        let approval = ctx
            .accounts
            .operator_approval
            .as_ref()
            .ok_or(VaultError::OperatorNotApproved)?;
        require!(
            approval.approved
                && approval.owner == redeem_request.owner
                && approval.operator == ctx.accounts.claimant.key()
                && approval.vault == ctx.accounts.vault.key(),
            VaultError::OperatorNotApproved
        );
    }

    require!(
        ctx.accounts.receiver.key() == redeem_request.receiver,
        VaultError::Unauthorized
    );
    require!(
        ctx.accounts.owner.key() == redeem_request.owner,
        VaultError::InvalidRequestOwner
    );

    let assets = redeem_request.assets_claimable;

    let vault = &ctx.accounts.vault;
    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[vault.bump],
    ]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.claimable_tokens.to_account_info(),
                to: ctx.accounts.receiver_asset_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    anchor_spl::token_interface::close_account(CpiContext::new_with_signer(
        ctx.accounts.asset_token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.claimable_tokens.to_account_info(),
            destination: ctx.accounts.owner.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        signer_seeds,
    ))?;

    emit!(RedeemClaimed {
        vault: vault.key(),
        owner: redeem_request.owner,
        receiver: redeem_request.receiver,
        assets,
    });

    Ok(())
}
