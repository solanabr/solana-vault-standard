use anchor_lang::prelude::*;
use anchor_spl::token_2022::{self, MintTo, Token2022};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::{
    constants::*,
    error::VaultError,
    events::DepositClaimed,
    state::{AsyncVault, DepositRequest, OperatorApproval, RequestStatus},
};

#[derive(Accounts)]
pub struct ClaimDeposit<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), deposit_request.owner.as_ref()],
        bump = deposit_request.bump,
        close = rent_receiver,
    )]
    pub deposit_request: Account<'info, DepositRequest>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = receiver_shares_account.mint == vault.shares_mint,
        constraint = receiver_shares_account.owner == deposit_request.receiver @ VaultError::Unauthorized,
    )]
    pub receiver_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// Optional operator approval for third-party claims
    pub operator_approval: Option<Account<'info, OperatorApproval>>,

    /// CHECK: Receives rent from closed PDA (must match deposit_request.owner)
    #[account(
        mut,
        constraint = rent_receiver.key() == deposit_request.owner @ VaultError::Unauthorized,
    )]
    pub rent_receiver: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handler(ctx: Context<ClaimDeposit>) -> Result<()> {
    let request = &ctx.accounts.deposit_request;

    require!(
        request.status == RequestStatus::Fulfilled,
        VaultError::RequestNotFulfilled
    );

    // Auth: claimer must be the receiver or an approved operator
    validate_claim_authority(
        &ctx.accounts.claimer,
        request.receiver,
        ctx.accounts.operator_approval.as_ref(),
        ctx.accounts.vault.key(),
        request.owner,
    )?;

    let shares = request.shares_claimable;

    // Mint shares to receiver — vault totals already updated at fulfillment (Bug #1)
    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        ASYNC_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

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
        shares,
    )?;

    // Mark as claimed (PDA closed via `close = rent_receiver`)
    let request = &mut ctx.accounts.deposit_request;
    request.status = RequestStatus::Claimed;

    emit!(DepositClaimed {
        vault: ctx.accounts.vault.key(),
        owner: request.owner,
        receiver: request.receiver,
        shares,
    });

    Ok(())
}

pub fn validate_claim_authority(
    signer: &Signer,
    receiver: Pubkey,
    approval: Option<&Account<OperatorApproval>>,
    vault_key: Pubkey,
    owner: Pubkey,
) -> Result<()> {
    if signer.key() == receiver {
        return Ok(());
    }

    let approval = approval.ok_or(error!(VaultError::Unauthorized))?;

    require!(approval.vault == vault_key, VaultError::Unauthorized);
    require!(approval.owner == owner, VaultError::Unauthorized);
    require!(approval.operator == signer.key(), VaultError::Unauthorized);
    require!(approval.can_claim, VaultError::OperatorNotApproved);

    Ok(())
}
