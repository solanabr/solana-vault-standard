use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{
    close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface,
    TransferChecked,
};

use crate::constants::{
    CLAIMABLE_TOKENS_SEED, REDEMPTION_ESCROW_SEED, REDEMPTION_REQUEST_SEED, SHARES_DECIMALS,
    VAULT_SEED,
};
use crate::error::VaultError;
use crate::events::RedemptionRejected;
use crate::state::{CreditVault, RedemptionRequest, RequestStatus};

#[derive(Accounts)]
pub struct RejectRedeem<'info> {
    pub manager: Signer<'info>,

    #[account(
        mut,
        has_one = manager,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, CreditVault>>,

    #[account(
        mut,
        close = investor,
        has_one = vault,
        seeds = [REDEMPTION_REQUEST_SEED, vault.key().as_ref(), redemption_request.investor.as_ref()],
        bump = redemption_request.bump,
        constraint = redemption_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
        constraint = redemption_request.assets_claimable == 0 @ VaultError::RequestPartiallyFulfilled,
    )]
    pub redemption_request: Box<Account<'info, RedemptionRequest>>,

    #[account(mut, constraint = investor.key() == redemption_request.investor)]
    pub investor: SystemAccount<'info>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(constraint = asset_mint.key() == vault.asset_mint)]
    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Empty (guarded by `assets_claimable == 0`); closed to refund rent.
    #[account(
        mut,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
        constraint = claimable_tokens.mint == vault.asset_mint @ VaultError::InvalidMintAccount,
        constraint = claimable_tokens.owner == vault.key() @ VaultError::Unauthorized,
    )]
    pub claimable_tokens: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = investor_shares_account.mint == vault.shares_mint,
        constraint = investor_shares_account.owner == investor.key(),
    )]
    pub investor_shares_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [REDEMPTION_ESCROW_SEED, vault.key().as_ref()],
        bump = vault.redemption_escrow_bump,
    )]
    pub redemption_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// V5-P20: This handler intentionally does NOT check vault.paused. During a pause,
/// the manager must still be able to reject pending redemption requests to clear the
/// queue and return escrowed shares to investors. Blocking rejections during pause
/// would trap investor shares in the escrow indefinitely.
pub fn handler(ctx: Context<RejectRedeem>, reason_code: u8) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    vault.total_pending_redeems = vault
        .total_pending_redeems
        .checked_sub(1)
        .ok_or(VaultError::MathOverflow)?;

    let shares_to_return = ctx.accounts.redemption_request.shares_locked;

    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let vault_bump_bytes = [ctx.accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id_bytes,
        &vault_bump_bytes,
    ];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.redemption_escrow.to_account_info(),
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.investor_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        shares_to_return,
        SHARES_DECIMALS,
    )?;

    close_account(CpiContext::new_with_signer(
        ctx.accounts.asset_token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.claimable_tokens.to_account_info(),
            destination: ctx.accounts.investor.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        &[vault_seeds],
    ))?;

    emit!(RedemptionRejected {
        vault: ctx.accounts.vault.key(),
        investor: ctx.accounts.investor.key(),
        shares: shares_to_return,
        reason_code,
    });

    Ok(())
}
