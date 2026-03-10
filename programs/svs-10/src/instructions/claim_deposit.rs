//! Claim deposit instruction: mint shares to receiver, close deposit request PDA.
//!
//! After the operator fulfills a deposit, the receiver (or an approved operator)
//! claims the computed shares. Shares are minted via Token-2022 CPI with the
//! vault PDA as mint authority.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022,
    token_interface::{Mint, Token2022, TokenAccount},
};

use crate::{
    constants::{DEPOSIT_REQUEST_SEED, VAULT_SEED},
    error::VaultError,
    events::DepositClaimed,
    state::{AsyncVault, DepositRequest, OperatorApproval, RequestStatus},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct ClaimDeposit<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        close = owner,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), deposit_request.owner.as_ref()],
        bump = deposit_request.bump,
        constraint = deposit_request.status == RequestStatus::Fulfilled @ VaultError::RequestNotFulfilled,
    )]
    pub deposit_request: Account<'info, DepositRequest>,

    /// CHECK: Owner receives rent refund on close
    #[account(mut)]
    pub owner: SystemAccount<'info>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = claimant,
        associated_token::mint = shares_mint,
        associated_token::authority = receiver,
        associated_token::token_program = token_2022_program,
    )]
    pub receiver_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Receiver derived from deposit_request
    pub receiver: SystemAccount<'info>,

    pub operator_approval: Option<Account<'info, OperatorApproval>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimDeposit>) -> Result<()> {
    let deposit_request = &ctx.accounts.deposit_request;

    let is_receiver = ctx.accounts.claimant.key() == deposit_request.receiver;
    if !is_receiver {
        let approval = ctx
            .accounts
            .operator_approval
            .as_ref()
            .ok_or(VaultError::OperatorNotApproved)?;
        require!(
            approval.approved
                && approval.owner == deposit_request.owner
                && approval.operator == ctx.accounts.claimant.key()
                && approval.vault == ctx.accounts.vault.key(),
            VaultError::OperatorNotApproved
        );
    }

    require!(
        ctx.accounts.receiver.key() == deposit_request.receiver,
        VaultError::Unauthorized
    );
    require!(
        ctx.accounts.owner.key() == deposit_request.owner,
        VaultError::InvalidRequestOwner
    );

    let vault = &ctx.accounts.vault;
    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[vault.bump],
    ]];

    token_2022::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            token_2022::MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.receiver_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        deposit_request.shares_claimable,
    )?;

    #[cfg(feature = "modules")]
    {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let timestamp = Clock::get()?.unix_timestamp;
        module_hooks::set_share_lock(remaining, &crate::ID, &vault_key, timestamp)?;
    }

    emit!(DepositClaimed {
        vault: vault.key(),
        owner: deposit_request.owner,
        receiver: deposit_request.receiver,
        shares: deposit_request.shares_claimable,
    });

    Ok(())
}
