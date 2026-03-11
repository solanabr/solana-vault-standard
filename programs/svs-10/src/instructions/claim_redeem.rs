//! claim_redeem: Transfer assets from claimable escrow to receiver.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::{ASYNC_VAULT_SEED, CLAIMABLE_SEED, CLAIMABLE_TOKENS_SEED, REDEEM_REQUEST_SEED},
    error::VaultError,
    events::RedeemClaimed,
    state::{AsyncVault, ClaimableEscrow, OperatorApproval, RedeemRequest, RequestStatus},
};

#[derive(Accounts)]
pub struct ClaimRedeem<'info> {
    /// Signer: must be receiver OR have valid OperatorApproval
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [ASYNC_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, AsyncVault>,

    /// RedeemRequest PDA — closed at the end, rent returned to owner
    #[account(
        mut,
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), redeem_request.owner.as_ref()],
        bump = redeem_request.bump,
        has_one = vault @ VaultError::Unauthorized,
        close = redeem_request_owner,
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    /// CHECK: receives rent from closed redeem_request — must equal redeem_request.owner
    #[account(
        mut,
        constraint = redeem_request_owner.key() == redeem_request.owner @ VaultError::Unauthorized,
    )]
    pub redeem_request_owner: UncheckedAccount<'info>,

    /// ClaimableEscrow PDA — tracks assets available to claim
    #[account(
        mut,
        seeds = [CLAIMABLE_SEED, vault.key().as_ref(), redeem_request.owner.as_ref()],
        bump = claimable_escrow.bump,
        has_one = vault @ VaultError::Unauthorized,
        close = redeem_request_owner,
    )]
    pub claimable_escrow: Account<'info, ClaimableEscrow>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint @ VaultError::Unauthorized,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// Per-user claimable token account — closed after transfer
    /// Seeds: ["claimable_tokens", vault_pda, owner]
    #[account(
        mut,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), redeem_request.owner.as_ref()],
        bump,
    )]
    pub claimable_tokens: InterfaceAccount<'info, TokenAccount>,

    /// Receiver's asset token account
    #[account(
        mut,
        constraint = receiver_asset_account.mint == vault.asset_mint @ VaultError::Unauthorized,
        constraint = receiver_asset_account.owner == receiver.key() @ VaultError::Unauthorized,
    )]
    pub receiver_asset_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: who will receive assets (must match redeem_request.receiver)
    #[account(
        constraint = receiver.key() == redeem_request.receiver @ VaultError::Unauthorized,
    )]
    pub receiver: UncheckedAccount<'info>,

    /// Optional OperatorApproval — pass if signer != receiver
    pub operator_approval: Option<Account<'info, OperatorApproval>>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimRedeem>) -> Result<()> {
    // 1. VALIDATION: request must be Fulfilled, escrow must have assets
    require!(
        ctx.accounts.redeem_request.status == RequestStatus::Fulfilled,
        VaultError::RequestNotPending
    );
    let assets_claimable = ctx.accounts.claimable_escrow.amount;
    require!(assets_claimable > 0, VaultError::EscrowEmpty);

    let signer_key = ctx.accounts.signer.key();
    let receiver_key = ctx.accounts.receiver.key();
    let owner = ctx.accounts.redeem_request.owner;
    let vault_key = ctx.accounts.vault.key();

    // 2. VALIDATE CLAIM AUTHORITY: signer must be receiver or approved operator
    validate_claim_authority(
        &signer_key,
        &receiver_key,
        ctx.accounts.operator_approval.as_ref(),
        &owner,
    )?;

    // 3. BUILD VAULT PDA SIGNER SEEDS
    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        ASYNC_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    // 4. TRANSFER ASSETS from claimable_tokens to receiver
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
        assets_claimable,
        ctx.accounts.asset_mint.decimals,
    )?;

    // 5. UPDATE REQUEST STATUS (account closed via `close = redeem_request_owner`)
    ctx.accounts.redeem_request.status = RequestStatus::Claimed;

    // 6. CLOSE CLAIMABLE_TOKENS token account — drain lamports to owner
    // Use the matching instruction builder for the asset's token program.
    use anchor_lang::solana_program::program::invoke_signed as invoke_s;

    let asset_program_key = ctx.accounts.asset_token_program.key();
    let close_ix = if asset_program_key == anchor_spl::token::ID {
        spl_token::instruction::close_account(
            &asset_program_key,
            &ctx.accounts.claimable_tokens.key(),
            &ctx.accounts.redeem_request_owner.key(),
            &vault_key,
            &[],
        )?
    } else {
        anchor_spl::token_2022::spl_token_2022::instruction::close_account(
            &asset_program_key,
            &ctx.accounts.claimable_tokens.key(),
            &ctx.accounts.redeem_request_owner.key(),
            &vault_key,
            &[],
        )?
    };

    invoke_s(
        &close_ix,
        &[
            ctx.accounts.claimable_tokens.to_account_info(),
            ctx.accounts.redeem_request_owner.to_account_info(),
            ctx.accounts.vault.to_account_info(),
        ],
        signer_seeds,
    )?;

    // 7. EMIT EVENT
    // (ClaimableEscrow PDA and RedeemRequest PDA are closed via `close = redeem_request_owner`)
    emit!(RedeemClaimed {
        vault: vault_key,
        owner,
        receiver: receiver_key,
        assets: assets_claimable,
    });

    Ok(())
}

/// Validate that signer is authorized to claim: must be receiver or approved operator.
fn validate_claim_authority(
    signer: &Pubkey,
    receiver: &Pubkey,
    operator_approval: Option<&Account<OperatorApproval>>,
    owner: &Pubkey,
) -> Result<()> {
    if signer == receiver {
        return Ok(());
    }

    match operator_approval {
        Some(approval) => {
            require!(
                approval.operator == *signer,
                VaultError::Unauthorized
            );
            require!(
                approval.owner == *owner,
                VaultError::Unauthorized
            );
            require!(approval.approved, VaultError::OperatorNotApproved);
            Ok(())
        }
        None => Err(error!(VaultError::Unauthorized)),
    }
}
