use anchor_lang::prelude::*;
use anchor_spl::token_2022::{self, Token2022};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::attestation::validate_attestation;
use crate::constants::{
    CLAIMABLE_TOKENS_SEED, FROZEN_ACCOUNT_SEED, NAV_ORACLE_PROGRAM_ID, NAV_ORACLE_SEED,
    ORACLE_SOURCE_MOCK, ORACLE_SOURCE_NAV_ORACLE, REDEMPTION_ESCROW_SEED, REDEMPTION_REQUEST_SEED,
    VAULT_SEED,
};
use crate::error::VaultError;
use crate::events::RedemptionApproved;
use crate::math;
use crate::oracle::{read_and_validate_oracle, read_nav_oracle_price, OraclePrice};
use crate::state::{CreditVault, RedemptionRequest, RequestStatus};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct ApproveRedeem<'info> {
    #[account(mut)]
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
        seeds = [REDEMPTION_REQUEST_SEED, vault.key().as_ref(), redemption_request.investor.as_ref()],
        bump = redemption_request.bump,
        constraint = redemption_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
    )]
    pub redemption_request: Box<Account<'info, RedemptionRequest>>,

    #[account(constraint = investor.key() == redemption_request.investor)]
    pub investor: SystemAccount<'info>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [REDEMPTION_ESCROW_SEED, vault.key().as_ref()],
        bump = vault.redemption_escrow_bump,
    )]
    pub redemption_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = deposit_vault.key() == vault.deposit_vault,
    )]
    pub deposit_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(constraint = asset_mint.key() == vault.asset_mint)]
    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Pre-created by `request_redeem`; topped up here; closed by
    /// `claim_redeem` / `cancel_redeem` / `reject_redeem`.
    #[account(
        mut,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
        constraint = claimable_tokens.mint == vault.asset_mint @ VaultError::InvalidMintAccount,
        constraint = claimable_tokens.owner == vault.key() @ VaultError::Unauthorized,
    )]
    pub claimable_tokens: Box<InterfaceAccount<'info, TokenAccount>>,

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

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

/// 1e18 = 100% (matches backend's fixed-point convention).
const RATIO_SCALE_1E18: u128 = 1_000_000_000_000_000_000;

pub fn handler(
    ctx: Context<ApproveRedeem>,
    batch_settlement_ratio_scaled: u128,
    next_settlement_at: i64,
) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(
        ctx.accounts.frozen_check.data_is_empty(),
        VaultError::AccountFrozen
    );

    require!(
        batch_settlement_ratio_scaled > 0 && batch_settlement_ratio_scaled <= RATIO_SCALE_1E18,
        VaultError::ZeroAmount
    );

    // Sentinel 0 = "no requeue date" (full fulfillment doesn't need one;
    // partials with 0 are valid but display as unscheduled). Any non-zero
    // value must fall within [now, now + MAX_SETTLEMENT_HORIZON_SECS].
    let now = ctx.accounts.clock.unix_timestamp;
    if next_settlement_at != 0 {
        let horizon = now
            .checked_add(crate::constants::MAX_SETTLEMENT_HORIZON_SECS)
            .ok_or(VaultError::MathOverflow)?;
        require!(
            next_settlement_at >= now && next_settlement_at <= horizon,
            VaultError::SettlementHorizonOutOfRange
        );
    }

    // Reconciliation: refuse to redeem if vault.total_shares has drifted
    // from the on-chain supply.
    require!(
        ctx.accounts.vault.total_shares == ctx.accounts.shares_mint.supply,
        VaultError::MathOverflow
    );

    validate_attestation(
        &ctx.accounts.attestation.to_account_info(),
        &ctx.accounts.vault,
        &ctx.accounts.investor.key(),
        &ctx.accounts.clock,
    )?;

    // Read NAV via the configured oracle source. Manual PDA check in the
    // nav-oracle branch (see nav_account doc-comment for the reason).
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

    // Deviation: compare oracle price against vault-derived expected price.
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

    // Pro-rata fulfill = floor(remaining × ratio / 1e18). Floor favors vault.
    // Parenthesize the division before the cast — `as u64` binds tighter than `/`.
    let request_snapshot = &ctx.accounts.redemption_request;
    let shares_locked = request_snapshot.shares_locked;
    let already_fulfilled = request_snapshot.fulfilled_shares_cumulative;
    let remaining = shares_locked
        .checked_sub(already_fulfilled)
        .ok_or(VaultError::MathOverflow)?;
    require!(remaining > 0, VaultError::ZeroAmount);

    let fulfill: u64 =
        (((remaining as u128) * batch_settlement_ratio_scaled) / RATIO_SCALE_1E18) as u64;
    require!(fulfill > 0, VaultError::ZeroAmount);
    require!(fulfill <= remaining, VaultError::MathOverflow);

    let gross_assets = math::shares_to_assets(fulfill, price)?;

    #[cfg(feature = "modules")]
    let net_assets = {
        let remaining_accounts = ctx.remaining_accounts;
        let vault_key = ctx.accounts.vault.key();
        let result =
            module_hooks::apply_exit_fee(remaining_accounts, &crate::ID, &vault_key, gross_assets)?;
        result.net_assets
    };
    #[cfg(not(feature = "modules"))]
    let net_assets = gross_assets;

    require!(net_assets > 0, VaultError::ZeroAmount);

    let available = ctx
        .accounts
        .deposit_vault
        .amount
        .checked_sub(ctx.accounts.vault.total_pending_deposits)
        .and_then(|v| v.checked_sub(ctx.accounts.vault.total_approved_deposits))
        .ok_or(VaultError::MathOverflow)?;
    require!(available >= net_assets, VaultError::InsufficientLiquidity);

    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let vault_bump_bytes = [ctx.accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id_bytes,
        &vault_bump_bytes,
    ];

    token_2022::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            token_2022::Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.redemption_escrow.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        fulfill,
    )?;

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.deposit_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                to: ctx.accounts.claimable_tokens.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        net_assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    let now = ctx.accounts.clock.unix_timestamp;
    let request = &mut ctx.accounts.redemption_request;
    let new_cumulative = request
        .fulfilled_shares_cumulative
        .checked_add(fulfill)
        .ok_or(VaultError::MathOverflow)?;
    request.fulfilled_shares_cumulative = new_cumulative;
    request.assets_claimable = request
        .assets_claimable
        .checked_add(net_assets)
        .ok_or(VaultError::MathOverflow)?;

    if new_cumulative >= shares_locked {
        request.status = RequestStatus::Approved;
        request.fulfilled_at = now;
    } else {
        request.queued_for_settlement_at = next_settlement_at;
    }

    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_sub(net_assets)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_sub(fulfill)
        .ok_or(VaultError::MathOverflow)?;
    // Pending counter only decrements on FULL fulfillment.
    if new_cumulative >= shares_locked {
        vault.total_pending_redeems = vault
            .total_pending_redeems
            .checked_sub(1)
            .ok_or(VaultError::MathOverflow)?;
    }

    vault.last_seen_nav_price = price;
    if vault.oracle_source == ORACLE_SOURCE_NAV_ORACLE {
        vault.last_seen_nav_sequence = oracle_read.sequence;
    }

    emit!(RedemptionApproved {
        vault: vault.key(),
        investor: ctx.accounts.investor.key(),
        shares: fulfill,
        assets: net_assets,
        nav: price,
        ratio_scaled: batch_settlement_ratio_scaled,
        cumulative_fulfilled: new_cumulative,
        next_settlement_at,
        manager: ctx.accounts.manager.key(),
    });

    Ok(())
}
