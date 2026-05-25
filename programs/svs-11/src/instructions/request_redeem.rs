//! Request redeem instruction.
//!
//! Intentionally does NOT require investment_window_open — investors should
//! always be able to signal intent to redeem, regardless of window state.
//! The manager gates actual execution via approve_redeem.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::extension::{
    transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi;

use crate::attestation::validate_attestation;
use crate::constants::{
    CLAIMABLE_TOKENS_SEED, FROZEN_ACCOUNT_SEED, REDEMPTION_ESCROW_SEED, REDEMPTION_REQUEST_SEED,
    SHARES_DECIMALS, VAULT_SEED,
};
use crate::error::VaultError;
use crate::events::RedemptionRequested;
use crate::state::{CreditVault, RedemptionRequest, RequestStatus};

fn read_hook_program_id(mint: &AccountInfo) -> Result<Option<Pubkey>> {
    if mint.owner != &spl_token_2022::ID {
        return Ok(None);
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Mint>::unpack(&data)
        .map_err(|_| error!(VaultError::InvalidMintAccount))?;
    match state.get_extension::<TransferHook>() {
        Ok(ext) => Ok(Option::<Pubkey>::from(ext.program_id)),
        Err(_) => Ok(None),
    }
}

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct RequestRedeem<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, CreditVault>>,

    #[account(
        init,
        payer = investor,
        space = RedemptionRequest::LEN,
        seeds = [REDEMPTION_REQUEST_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub redemption_request: Box<Account<'info, RedemptionRequest>>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: Box<InterfaceAccount<'info, Mint>>,

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

    #[account(constraint = asset_mint.key() == vault.asset_mint)]
    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Pre-allocated payout PDA for the request's lifetime. `approve_redeem`
    /// tops it up; `claim_redeem` / `cancel_redeem` / `reject_redeem` close it.
    /// Per-request creation removes the need for `init_if_needed` in `approve_redeem`.
    #[account(
        init,
        payer = investor,
        token::mint = asset_mint,
        token::authority = vault,
        token::token_program = asset_token_program,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub claimable_tokens: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Attestation validated in handler via validate_attestation
    pub attestation: UncheckedAccount<'info>,

    /// CHECK: If data is non-empty, investor is frozen
    #[account(
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub frozen_check: UncheckedAccount<'info>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, RequestRedeem<'info>>,
    shares: u64,
    queued_for_settlement_at: i64,
) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);

    validate_attestation(
        &ctx.accounts.attestation.to_account_info(),
        &ctx.accounts.vault,
        &ctx.accounts.investor.key(),
        &ctx.accounts.clock,
    )?;

    require!(
        ctx.accounts.frozen_check.data_is_empty(),
        VaultError::AccountFrozen
    );

    #[cfg(feature = "modules")]
    {
        let remaining = ctx.remaining_accounts;
        let vault_key = ctx.accounts.vault.key();
        let investor_key = ctx.accounts.investor.key();

        module_hooks::check_withdrawal_access(remaining, &crate::ID, &vault_key, &investor_key)?;

        let current_timestamp = Clock::get()?.unix_timestamp;
        module_hooks::check_share_lock(
            remaining,
            &crate::ID,
            &vault_key,
            &investor_key,
            current_timestamp,
        )?;
    }

    // shares_mint TransferHook requires the EAML extras be in the inner
    // ix's keys list, not just in the surrounding tx accounts. Build the
    // bare spl-token-2022 ix and extend via `add_extra_accounts_for_execute_cpi`.
    // Callers pass the EAML extras (investor → redemption_escrow direction)
    // as `remainingAccounts`.
    let mut transfer_ix = spl_token_2022::instruction::transfer_checked(
        &spl_token_2022::ID,
        &ctx.accounts.investor_shares_account.key(),
        &ctx.accounts.shares_mint.key(),
        &ctx.accounts.redemption_escrow.key(),
        &ctx.accounts.investor.key(),
        &[],
        shares,
        SHARES_DECIMALS,
    )?;
    let mut transfer_account_infos: Vec<AccountInfo<'info>> = vec![
        ctx.accounts.investor_shares_account.to_account_info(),
        ctx.accounts.shares_mint.to_account_info(),
        ctx.accounts.redemption_escrow.to_account_info(),
        ctx.accounts.investor.to_account_info(),
    ];
    if let Some(hook_program_id) =
        read_hook_program_id(&ctx.accounts.shares_mint.to_account_info())?
    {
        add_extra_accounts_for_execute_cpi(
            &mut transfer_ix,
            &mut transfer_account_infos,
            &hook_program_id,
            ctx.accounts.investor_shares_account.to_account_info(),
            ctx.accounts.shares_mint.to_account_info(),
            ctx.accounts.redemption_escrow.to_account_info(),
            ctx.accounts.investor.to_account_info(),
            shares,
            ctx.remaining_accounts,
        )
        .map_err(|_| -> Error { error!(VaultError::HookExtrasMismatch) })?;
    }
    invoke_signed(&transfer_ix, &transfer_account_infos, &[])?;

    // V7-P5: total_pending_redeems tracks REQUEST COUNT (not shares). This differs from
    // SVS-10 which tracks total locked shares. The counter is used for operational
    // monitoring only — it does NOT affect share price calculations.
    let vault = &mut ctx.accounts.vault;
    vault.total_pending_redeems = vault
        .total_pending_redeems
        .checked_add(1)
        .ok_or(VaultError::MathOverflow)?;

    let request = &mut ctx.accounts.redemption_request;
    request.investor = ctx.accounts.investor.key();
    request.vault = ctx.accounts.vault.key();
    request.shares_locked = shares;
    request.assets_claimable = 0;
    request.status = RequestStatus::Pending;
    request.requested_at = ctx.accounts.clock.unix_timestamp;
    request.fulfilled_at = 0;
    request.bump = ctx.bumps.redemption_request;

    request.original_shares = shares;
    request.queued_for_settlement_at = queued_for_settlement_at;
    request.fulfilled_shares_cumulative = 0;

    emit!(RedemptionRequested {
        vault: ctx.accounts.vault.key(),
        investor: ctx.accounts.investor.key(),
        shares,
    });

    Ok(())
}
