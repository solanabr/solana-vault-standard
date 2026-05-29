use anchor_lang::prelude::*;
use anchor_spl::token_2022::{self, Token2022};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::attestation::validate_attestation;
use crate::constants::{
    CLAIMABLE_TOKENS_SEED, COMPLIANCE_HOOK_PROGRAM_ID, REDEMPTION_ESCROW_SEED,
    REDEMPTION_REQUEST_SEED, VAULT_SEED,
};
use crate::error::VaultError;
use crate::events::RedemptionApproved;
use crate::math;
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

    /// CHECK: the configured oracle account. Validated in handler:
    /// key == vault.nav_oracle, owner == vault.oracle_program, then the
    /// generic SvsOraclePrice header is read + range-checked.
    pub oracle_account: UncheckedAccount<'info>,

    /// CHECK: Attestation validated in handler via validate_attestation
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

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

/// 1e18 = 100% (matches backend's fixed-point convention).
pub fn handler(ctx: Context<ApproveRedeem>) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);

    compliance_hook::assert_wallet_compliant(
        &ctx.accounts.sanctions_list,
        &ctx.accounts.frozen_check.to_account_info(),
        &ctx.accounts.investor.key(),
    )?;

    // Reconciliation: refuse to redeem if vault.total_shares has drifted from
    // the on-chain supply. This check is one-sided by design — it lives only on
    // the burn path (approve_redeem), which is the only place that decrements
    // total_shares. claim_deposit (the mint path) increments total_shares
    // atomically with its mint_to CPI and has no independent drift source, so it
    // does not re-derive the check.
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

    // No books-vs-oracle deviation guard — see approve_deposit.

    // Full-approval: burn ALL locked shares, pay out their full asset value.
    let shares_locked = ctx.accounts.redemption_request.shares_locked;
    require!(shares_locked > 0, VaultError::ZeroAmount);

    let gross_assets = math::shares_to_assets(shares_locked, price)?;

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
        shares_locked,
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
    request.assets_claimable = net_assets;
    request.status = RequestStatus::Approved;
    request.fulfilled_at = now;

    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_sub(net_assets)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_sub(shares_locked)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_pending_redeems = vault
        .total_pending_redeems
        .checked_sub(1)
        .ok_or(VaultError::MathOverflow)?;

    // sequence == 0 is the "unused" sentinel; don't advance on it.
    if header.sequence != 0 {
        vault.last_seen_nav_sequence = header.sequence;
    }

    emit!(RedemptionApproved {
        vault: vault.key(),
        investor: ctx.accounts.investor.key(),
        shares: shares_locked,
        assets: net_assets,
        nav: price,
        manager: ctx.accounts.manager.key(),
    });

    Ok(())
}
