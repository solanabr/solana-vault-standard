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
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi;

use crate::attestation::validate_attestation;
use crate::constants::{
    FROZEN_ACCOUNT_SEED, REDEMPTION_ESCROW_SEED, REDEMPTION_REQUEST_SEED, SHARES_DECIMALS,
    VAULT_SEED,
};
use crate::error::VaultError;
use crate::events::RedemptionRequested;
use crate::state::{CreditVault, RedemptionRequest, RequestStatus};

/// Extract the hook program ID from a Token-2022 mint's `TransferHook`
/// extension. Returns `None` for legacy SPL mints, mints without the
/// extension, or mints with the extension explicitly cleared.
///
/// Same helper as `derwa-wrapper::wrap::read_hook_program_id` —
/// duplicated rather than refactored into a shared module to keep the
/// CPI extension self-contained at each call site. Mirrored here so
/// svs-11's redemption flow extends its cPOOL `transfer_checked` ix with
/// the hook accounts (otherwise the CPI hits "Unknown program" when the
/// runtime tries to invoke the hook program ID found in the mint's
/// TransferHook extension).
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

    /// CHECK: Attestation validated in handler via validate_attestation
    pub attestation: UncheckedAccount<'info>,

    /// CHECK: If data is non-empty, investor is frozen
    #[account(
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub frozen_check: UncheckedAccount<'info>,

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

    // Transfer cPOOL shares from investor → redemption_escrow.
    //
    // The shares mint carries the Token-2022 TransferHook extension
    // (bound to compliance-hook in Permissioned mode by
    // `initialize_pool`). Token-2022's `invoke_execute` requires the
    // hook program account + EAML PDA + resolved EAML extras to be in
    // the INNER `transfer_checked` ix's keys list — not just in the
    // surrounding tx accounts. `anchor_spl::token_interface::transfer_checked`
    // builds the bare ix with only canonical 4 keys, which makes the
    // CPI fail with "Unknown program" once the cPOOL hook is active.
    //
    // We mirror the pattern used in `derwa-wrapper::wrap` /
    // `derwa-wrapper::unwrap`: build the bare ix from spl-token-2022,
    // let `add_extra_accounts_for_execute_cpi` extend BOTH the ix keys
    // list AND the cpi_account_infos with the hook accounts (sourced
    // from `ctx.remaining_accounts`), then `invoke_signed`. The
    // off-chain callers pass the EAML extras for the `(source = investor,
    // destination = redemption_escrow)` direction as `remainingAccounts`
    // on the request_redeem ix.
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

    // Pro-rata fulfillment + auto-requeue defaults.
    // `original_shares` snapshots the initial intent and is never
    // mutated after creation; consumers compare `original_shares` vs
    // `fulfilled_shares_cumulative` to display per-investor settlement
    // progress. `queued_for_settlement_at` is computed off-chain by
    // the backend's redemption-scheduler service and passed in here.
    // `fulfilled_shares_cumulative` starts at 0; `approve_redeem`
    // accumulates across one or more partial-fulfillment calls.
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
