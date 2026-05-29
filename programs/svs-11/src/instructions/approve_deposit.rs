use anchor_lang::prelude::*;

use crate::attestation::validate_attestation;
use crate::constants::{INVESTMENT_REQUEST_SEED, VAULT_SEED};
use crate::error::VaultError;
use crate::events::InvestmentApproved;
use crate::math;
use crate::state::{CreditVault, InvestmentRequest, RequestStatus};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct ApproveDeposit<'info> {
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
        has_one = vault,
        seeds = [INVESTMENT_REQUEST_SEED, vault.key().as_ref(), investment_request.investor.as_ref()],
        bump = investment_request.bump,
        constraint = investment_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
    )]
    pub investment_request: Box<Account<'info, InvestmentRequest>>,

    #[account(constraint = investor.key() == investment_request.investor)]
    pub investor: SystemAccount<'info>,

    /// CHECK: the configured oracle account. Validated in handler:
    /// key == vault.nav_oracle, owner == vault.oracle_program, then the
    /// generic SvsOraclePrice header is read + range-checked.
    pub oracle_account: UncheckedAccount<'info>,

    /// CHECK: Attestation validated in handler via validate_attestation
    pub attestation: UncheckedAccount<'info>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(ctx: Context<ApproveDeposit>) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(
        ctx.accounts.vault.investment_window_open,
        VaultError::InvestmentWindowClosed
    );

    validate_attestation(
        &ctx.accounts.attestation.to_account_info(),
        &ctx.accounts.vault,
        &ctx.accounts.investor.key(),
        &ctx.accounts.clock,
    )?;

    require!(
        ctx.accounts.oracle_account.key() == ctx.accounts.vault.nav_oracle,
        VaultError::OracleInvalidPrice
    );
    require!(
        ctx.accounts.oracle_account.owner == &ctx.accounts.vault.oracle_program,
        VaultError::OracleInvalidProgram
    );
    let header = {
        let data = ctx.accounts.oracle_account.try_borrow_data()?;
        svs_oracle::read_oracle(
            &data,
            ctx.accounts.clock.unix_timestamp,
            ctx.accounts.vault.max_staleness,
            ctx.accounts.vault.last_seen_nav_sequence,
        )
        .map_err(|e| match e {
            svs_oracle::OracleError::StalePrice => error!(VaultError::OracleStale),
            svs_oracle::OracleError::SequenceStale => error!(VaultError::OracleSequenceStale),
            _ => error!(VaultError::OracleInvalidPrice),
        })?
    };
    let price = header.price;

    // No books-vs-oracle deviation guard: total_assets is idle cash, not NAV
    // (draw_down deploys capital), so it would falsely trip once deployed.

    let amount_locked = ctx.accounts.investment_request.amount_locked;
    let shares = math::assets_to_shares(amount_locked, price)?;
    require!(shares > 0, VaultError::ZeroAmount);

    #[cfg(feature = "modules")]
    let shares = {
        let remaining = ctx.remaining_accounts;
        let vault_key = ctx.accounts.vault.key();
        let result = module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    require!(shares > 0, VaultError::ZeroAmount);

    let request = &mut ctx.accounts.investment_request;
    request.status = RequestStatus::Approved;
    request.shares_claimable = shares;
    request.fulfilled_at = ctx.accounts.clock.unix_timestamp;

    // Move assets from pending → approved bucket.
    // total_assets and total_shares are updated at claim time after the mint CPI.
    let vault = &mut ctx.accounts.vault;
    vault.total_pending_deposits = vault
        .total_pending_deposits
        .checked_sub(amount_locked)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_approved_deposits = vault
        .total_approved_deposits
        .checked_add(amount_locked)
        .ok_or(VaultError::MathOverflow)?;

    // sequence == 0 is the "unused" sentinel; don't advance on it.
    if header.sequence != 0 {
        vault.last_seen_nav_sequence = header.sequence;
    }

    emit!(InvestmentApproved {
        vault: vault.key(),
        investor: ctx.accounts.investor.key(),
        amount: amount_locked,
        shares,
        nav: price,
    });

    Ok(())
}
