use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::Token2022,
    token_interface::{mint_to, Mint, MintTo, TokenAccount},
};

use crate::attestation::validate_attestation;
use crate::constants::{
    COMPLIANCE_HOOK_PROGRAM_ID, INVESTMENT_REQUEST_SEED, SHARES_MINT_SEED, VAULT_SEED,
};
use crate::error::VaultError;
use crate::events::InvestmentClaimed;
use crate::state::{CreditVault, InvestmentRequest, RequestStatus};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct ClaimDeposit<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, CreditVault>>,

    #[account(
        mut,
        close = investor,
        has_one = vault,
        seeds = [INVESTMENT_REQUEST_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump = investment_request.bump,
        constraint = investment_request.status == RequestStatus::Approved @ VaultError::RequestNotApproved,
        constraint = investor.key() == investment_request.investor,
    )]
    pub investment_request: Box<Account<'info, InvestmentRequest>>,

    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = shares_mint,
        associated_token::authority = investor,
        associated_token::token_program = token_2022_program,
    )]
    pub investor_shares_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Validated in handler via validate_attestation
    pub attestation: UncheckedAccount<'info>,

    /// Protocol-level singleton sanctions list (owned by compliance-hook).
    #[account(
        seeds = [compliance_hook::state::SanctionsList::SEED_PREFIX],
        bump,
        seeds::program = COMPLIANCE_HOOK_PROGRAM_ID,
    )]
    pub sanctions_list: Box<Account<'info, compliance_hook::state::SanctionsList>>,

    /// CHECK: [b"frozen", investor] in compliance-hook. Existence (program-owned,
    /// non-empty) = frozen. Validated by assert_wallet_compliant.
    #[account(
        seeds = [compliance_hook::state::FrozenAccount::SEED_PREFIX, investor.key().as_ref()],
        bump,
        seeds::program = COMPLIANCE_HOOK_PROGRAM_ID,
    )]
    pub frozen_check: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub clock: Sysvar<'info, Clock>,
}

/// V5-P24: This handler intentionally does NOT check vault.paused. Already-approved
/// deposits have committed funds (assets locked in deposit_vault, shares computed).
/// Blocking claims during a pause would trap investor funds and violate the approval
/// guarantee. The pause mechanism is designed to halt NEW operations (requests,
/// approvals), not to block settlement of already-approved claims.
pub fn handler(ctx: Context<ClaimDeposit>) -> Result<()> {
    validate_attestation(
        &ctx.accounts.attestation.to_account_info(),
        &ctx.accounts.vault,
        &ctx.accounts.investor.key(),
        &ctx.accounts.clock,
    )?;

    compliance_hook::assert_wallet_compliant(
        &ctx.accounts.sanctions_list,
        &ctx.accounts.frozen_check.to_account_info(),
        &ctx.accounts.investor.key(),
    )?;

    let shares = ctx.accounts.investment_request.shares_claimable;
    let amount_locked = ctx.accounts.investment_request.amount_locked;

    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let vault_bump_bytes = [ctx.accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id_bytes,
        &vault_bump_bytes,
    ];

    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.investor_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        shares,
    )?;

    let vault = &mut ctx.accounts.vault;
    vault.total_approved_deposits = vault
        .total_approved_deposits
        .checked_sub(amount_locked)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_assets = vault
        .total_assets
        .checked_add(amount_locked)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_add(shares)
        .ok_or(VaultError::MathOverflow)?;

    // V9-P12: set_share_lock currently operates at vault-level only (no per-user PDA).
    // It computes a locked_until timestamp from LockConfig but does not write to a
    // per-user ShareLock PDA because the hook lacks a user_key parameter and write
    // access to the ShareLock account. To enable per-user share locking on claim,
    // the module hook needs a user_key parameter and the ShareLock PDA in
    // remaining_accounts with mut access. Documented as known limitation.
    #[cfg(feature = "modules")]
    {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let timestamp = Clock::get()?.unix_timestamp;
        module_hooks::set_share_lock(remaining, &crate::ID, &vault_key, timestamp)?;
    }

    emit!(InvestmentClaimed {
        vault: vault.key(),
        investor: ctx.accounts.investor.key(),
        shares,
    });

    Ok(())
}
