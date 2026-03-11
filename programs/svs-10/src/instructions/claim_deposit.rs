//! claim_deposit: Mint shares_claimable to receiver after deposit fulfillment.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, MintTo, Token2022},
    token_interface::{Mint, TokenAccount},
};

use crate::{
    constants::{ASYNC_VAULT_SEED, DEPOSIT_REQUEST_SEED},
    error::VaultError,
    events::DepositClaimed,
    state::{AsyncVault, DepositRequest, OperatorApproval, RequestStatus},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct ClaimDeposit<'info> {
    /// Signer: must be receiver OR have valid OperatorApproval
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [ASYNC_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), deposit_request.owner.as_ref()],
        bump = deposit_request.bump,
        has_one = vault @ VaultError::Unauthorized,
        close = deposit_request_owner,
    )]
    pub deposit_request: Account<'info, DepositRequest>,

    /// CHECK: receives rent from closed deposit_request — must equal deposit_request.owner
    #[account(
        mut,
        constraint = deposit_request_owner.key() == deposit_request.owner @ VaultError::Unauthorized,
    )]
    pub deposit_request_owner: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint @ VaultError::Unauthorized,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    /// Receiver's shares token account — created if needed
    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = shares_mint,
        associated_token::authority = receiver,
        associated_token::token_program = token_2022_program,
    )]
    pub receiver_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: who will receive shares (must match deposit_request.receiver)
    #[account(
        constraint = receiver.key() == deposit_request.receiver @ VaultError::Unauthorized,
    )]
    pub receiver: UncheckedAccount<'info>,

    /// Optional OperatorApproval — pass if signer != receiver
    pub operator_approval: Option<Account<'info, OperatorApproval>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimDeposit>) -> Result<()> {
    // 1. VALIDATION: request must be Fulfilled
    require!(
        ctx.accounts.deposit_request.status == RequestStatus::Fulfilled,
        VaultError::RequestNotFulfilled
    );

    let signer_key = ctx.accounts.signer.key();
    let receiver_key = ctx.accounts.receiver.key();
    let owner = ctx.accounts.deposit_request.owner;
    let shares_claimable = ctx.accounts.deposit_request.shares_claimable;
    let vault_key = ctx.accounts.vault.key();

    // 2. VALIDATE CLAIM AUTHORITY: signer must be receiver or approved operator
    validate_claim_authority(
        &signer_key,
        &receiver_key,
        ctx.accounts.operator_approval.as_ref(),
        &owner,
    )?;

    // 3. BUILD VAULT SIGNER SEEDS
    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        ASYNC_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    // 4. MINT SHARES to receiver
    token_2022::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.receiver_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares_claimable,
    )?;

    // 5. MODULE HOOK: set share lock at claim time
    #[cfg(feature = "modules")]
    {
        let remaining = ctx.remaining_accounts;
        module_hooks::set_share_lock(remaining, &crate::ID, &vault_key, &receiver_key)?;
    }

    // 6. UPDATE REQUEST STATUS (account closed via `close = deposit_request_owner`)
    // We set status to Claimed before closure so events are accurate.
    ctx.accounts.deposit_request.status = RequestStatus::Claimed;

    // 7. EMIT EVENT
    emit!(DepositClaimed {
        vault: vault_key,
        owner,
        receiver: receiver_key,
        shares: shares_claimable,
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
    // Receiver can always claim their own shares
    if signer == receiver {
        return Ok(());
    }

    // Otherwise require a valid OperatorApproval
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
