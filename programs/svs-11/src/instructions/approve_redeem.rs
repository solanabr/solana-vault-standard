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

    /// `init_if_needed` so partial-fulfillment retries don't fail
    /// re-init on the second approve_redeem for the same request.
    /// First call creates the PDA; subsequent calls top up via the
    /// transfer_checked below. claim_redeem closes it on terminal claim.
    #[account(
        init_if_needed,
        payer = manager,
        token::mint = asset_mint,
        token::authority = vault,
        token::token_program = asset_token_program,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub claimable_tokens: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Legacy mock-oracle account. Read in the `oracle_source == 0`
    /// branch via `read_and_validate_oracle`. Field is `nav_oracle` for
    /// backwards-compat with existing IDL clients (the underlying account
    /// has always been the mock oracle); semantically this slot holds the
    /// "mock_oracle_account".
    pub nav_oracle: UncheckedAccount<'info>,

    /// CHECK: NavAccount PDA from the nav-oracle program. Read in the
    /// `oracle_source == 1` branch via `read_nav_oracle_price`.
    ///
    /// IMPORTANT: we INTENTIONALLY OMIT the
    /// `seeds = [NAV_ORACLE_SEED, vault.key().as_ref()]` + `bump` +
    /// `seeds::program = NAV_ORACLE_PROGRAM_ID` constraints here.
    /// Anchor validates seed constraints at deserialization time,
    /// BEFORE the handler runs. With seeds enforced, the
    /// emergency-revert path (`oracle_source == 0` + caller passes a
    /// dummy account because they don't have a real NavAccount yet)
    /// FAILS at pre-handler validation, defeating the entire
    /// emergency-revert design. See approve_deposit for full rationale.
    ///
    /// We MANUALLY validate the PDA derivation + program ownership inside
    /// the handler when `oracle_source == 1` (see branch below).
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

/// Fixed-point scale used by `batch_settlement_ratio_scaled` (1e18 = 100%).
/// Matches the spec convention so backend can compute ratios in the same
/// fixed-point space the on-chain handler uses for division.
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

    // Guard against malformed ratios. 0 ⇒ nothing to fulfill (caller
    // should reject_redeem instead). > 1e18 ⇒ would over-burn the
    // remaining shares; cap at 1e18 so a buggy backend doesn't bypass
    // the remaining-shares math.
    require!(
        batch_settlement_ratio_scaled > 0 && batch_settlement_ratio_scaled <= RATIO_SCALE_1E18,
        VaultError::ZeroAmount
    );

    // Bound the manager-supplied next_settlement_at. Without this,
    // a stuck scheduler could queue redemptions to year 9999 and
    // downstream monitoring would flag them indistinguishably from
    // a real bug. Allow now..now+MAX_SETTLEMENT_HORIZON_SECS.
    let now = ctx.accounts.clock.unix_timestamp;
    let horizon = now
        .checked_add(crate::constants::MAX_SETTLEMENT_HORIZON_SECS)
        .ok_or(VaultError::MathOverflow)?;
    require!(
        next_settlement_at >= now && next_settlement_at <= horizon,
        VaultError::SettlementHorizonOutOfRange
    );

    // V4-P20 FIX: Reconciliation check — verify stored total_shares matches
    // shares_mint.supply. If they diverge, something has gone wrong and we
    // should not proceed with a redemption based on stale share counts.
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

    // Read NAV via the configured oracle source (emergency-revert
    // toggle). See approve_deposit for the rationale on the no-seeds
    // constraint on nav_account; manual PDA check happens in the
    // nav-oracle branch.
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
            msg!(
                "WARNING: CreditVault.oracle_source=0 (mock); revert mode active. \
                 NAV freshness from nav-oracle NOT enforced."
            );
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

    // V5-P9: Deviation check — compare oracle price against vault-derived expected price.
    // SVS-11 (credit vault) does not use ERC-4626-style virtual shares/assets (no
    // decimals_offset), so the simple ratio (total_assets * PRICE_SCALE / total_shares)
    // is the correct expected price. This differs from SVS-10 which uses convert_to_assets
    // with decimals_offset to account for virtual share inflation.
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

    // Compute the pro-rata cut for THIS settlement.
    //
    // `remaining` = shares not yet fulfilled across prior partial settlements
    // (or the full `shares_locked` on the first call). `fulfill` is the
    // floor-rounded portion of `remaining` allocated to this batch. Round-
    // down favors the vault: a residual sub-1-share dust never burns more
    // than the ratio actually allows.
    //
    // CRITICAL precedence note: Rust's `as u64` binds tighter than `/`,
    // so we MUST parenthesize the division before
    // the cast. The form `(((remaining as u128) * ratio) / 1e18) as u64`
    // is correct; `(remaining as u128) * ratio / 1e18 as u64` would
    // truncate `1e18` to `u64::MAX` first and produce nonsense.
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

    // Accumulate fulfilled shares + branch on
    // full vs partial fulfillment.
    //
    // Full fulfillment: cumulative reaches/exceeds shares_locked → status
    // flips to Approved, `fulfilled_at` is stamped, request stays open
    // until claim_redeem closes it (existing flow).
    //
    // Partial: cumulative < shares_locked → status stays Pending,
    // `queued_for_settlement_at` advances to the next-batch epoch passed
    // by the manager. The PDA stays alive so the next approve_redeem call
    // can fulfill the remainder.
    //
    // `assets_claimable` ACCUMULATES across settlements (not overwritten)
    // so claim_redeem can transfer the cumulative payout in a single ix.
    // The on-chain ATA `claimable_tokens` already holds the cumulative
    // balance (via the transfer_checked above on each call); the PDA
    // field stays in sync for off-chain consumers reading the request.
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
        // queued_for_settlement_at intentionally NOT bumped on full
        // fulfillment — the request is terminal.
    } else {
        // Partial: stays Pending; auto-requeue to the next settlement date.
        // (status already Pending per the Accounts constraint above.)
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
    // Only decrement the pending counter on FULL fulfillment — a partial
    // settlement leaves the request in the queue, so the count of pending
    // requests is unchanged. (cancel/reject continue to handle the
    // mid-flight cleanup paths.)
    if new_cumulative >= shares_locked {
        vault.total_pending_redeems = vault
            .total_pending_redeems
            .checked_sub(1)
            .ok_or(VaultError::MathOverflow)?;
    }

    // Persist NAV bookkeeping (mirrors approve_deposit). Sequence is only
    // advanced for the nav-oracle path; mock returns sentinel 0.
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
