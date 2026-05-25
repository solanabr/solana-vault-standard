use anchor_lang::prelude::*;

use crate::attestation::validate_attestation;
use crate::constants::{
    FROZEN_ACCOUNT_SEED, INVESTMENT_REQUEST_SEED, NAV_ORACLE_PROGRAM_ID, NAV_ORACLE_SEED,
    ORACLE_SOURCE_MOCK, ORACLE_SOURCE_NAV_ORACLE, VAULT_SEED,
};
use crate::error::VaultError;
use crate::events::InvestmentApproved;
use crate::math;
use crate::oracle::{read_and_validate_oracle, read_nav_oracle_price, OraclePrice};
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

    /// CHECK: Oracle account. When `oracle_source == 0` this is the mock
    /// oracle (read via `read_and_validate_oracle`); when `oracle_source == 1`
    /// it is unused (the nav-oracle path uses `nav_account` instead).
    pub nav_oracle: UncheckedAccount<'info>,

    /// CHECK: Manually validated in handler when `oracle_source == 1`.
    /// No seed constraint here — Anchor evaluates seeds pre-handler, which
    /// would fail the emergency-revert path where the caller passes a
    /// dummy account because they have no real NavAccount yet.
    pub nav_account: UncheckedAccount<'info>,

    /// CHECK: Attestation validated in handler via validate_attestation
    pub attestation: UncheckedAccount<'info>,

    /// CHECK: If data is non-empty, investor is frozen
    #[account(
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub frozen_check: UncheckedAccount<'info>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(ctx: Context<ApproveDeposit>) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(
        ctx.accounts.vault.investment_window_open,
        VaultError::InvestmentWindowClosed
    );
    require!(
        ctx.accounts.frozen_check.data_is_empty(),
        VaultError::AccountFrozen
    );

    validate_attestation(
        &ctx.accounts.attestation.to_account_info(),
        &ctx.accounts.vault,
        &ctx.accounts.investor.key(),
        &ctx.accounts.clock,
    )?;

    // Oracle source dispatch. Emergency-revert toggle: governance can flip
    // to mock if nav-oracle has a bug post-deploy.
    let oracle_read: OraclePrice = match ctx.accounts.vault.oracle_source {
        ORACLE_SOURCE_NAV_ORACLE => {
            let credit_vault_key = ctx.accounts.vault.key();
            let (expected_nav_pda, _bump) = Pubkey::find_program_address(
                &[NAV_ORACLE_SEED, credit_vault_key.as_ref()],
                &NAV_ORACLE_PROGRAM_ID,
            );
            require!(
                ctx.accounts.nav_account.key() == expected_nav_pda,
                VaultError::OracleAccountInvalid
            );
            require!(
                ctx.accounts.nav_account.owner == &NAV_ORACLE_PROGRAM_ID,
                VaultError::OracleAccountInvalid
            );

            let r = read_nav_oracle_price(
                &ctx.accounts.nav_account.to_account_info(),
                &credit_vault_key,
                ctx.accounts.vault.last_seen_nav_sequence,
                ctx.accounts.vault.max_nav_staleness_secs,
                ctx.accounts.vault.max_deviation_bps,
                Some(ctx.accounts.vault.last_seen_nav_price),
            )?;
            OraclePrice {
                price: r.price,
                sequence: r.sequence,
            }
        }
        ORACLE_SOURCE_MOCK => {
            let p = read_and_validate_oracle(
                &ctx.accounts.nav_oracle.to_account_info(),
                &ctx.accounts.vault,
                &ctx.accounts.clock,
            )?;
            OraclePrice {
                price: p,
                sequence: 0,
            }
        }
        _ => return err!(VaultError::OracleSourceInvalid),
    };

    let price = oracle_read.price;

    let vault = &ctx.accounts.vault;
    if vault.total_shares > 0 && vault.total_assets > 0 {
        let expected_price_u128 = (vault.total_assets as u128)
            .checked_mul(svs_oracle::PRICE_SCALE as u128)
            .and_then(|v| v.checked_div(vault.total_shares as u128))
            .ok_or(VaultError::MathOverflow)?;
        require!(
            expected_price_u128 <= u64::MAX as u128,
            VaultError::MathOverflow
        );
        svs_oracle::validate_deviation(price, expected_price_u128 as u64, vault.max_deviation_bps)
            .map_err(|_| VaultError::OracleDeviationExceeded)?;
    }
    // Oracle price validity (staleness, positive price) is always enforced by
    // read_and_validate_oracle above, even on the first deposit when there is no
    // on-chain expected price to compare against.

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

    // Persist NAV bookkeeping. We always record the last-seen price (used by
    // both the deviation guard and by analytics). We only advance
    // `last_seen_nav_sequence` when reading from the nav-oracle program;
    // the mock-oracle path uses sequence=0 as a sentinel and must not corrupt
    // the monotonic counter.
    vault.last_seen_nav_price = price;
    if vault.oracle_source == ORACLE_SOURCE_NAV_ORACLE {
        vault.last_seen_nav_sequence = oracle_read.sequence;
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
