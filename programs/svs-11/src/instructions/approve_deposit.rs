use anchor_lang::prelude::*;
use anchor_spl::token_2022::{self, MintTo, Token2022};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::{
    constants::*,
    error::VaultError,
    events::InvestmentApproved,
    instructions::oracle_lookup::{check_not_frozen, find_oracle_price, validate_attestation},
    state::{CreditVault, InvestmentRequest, RequestStatus},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct ApproveDeposit<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        mut,
        constraint = vault.manager == manager.key() @ VaultError::Unauthorized,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [INVESTMENT_REQUEST_SEED, vault.key().as_ref(), investment_request.investor.as_ref()],
        bump = investment_request.bump,
        close = investor,
    )]
    pub investment_request: Account<'info, InvestmentRequest>,

    /// CHECK: Validated via investment_request.investor
    #[account(
        mut,
        constraint = investor.key() == investment_request.investor @ VaultError::Unauthorized,
    )]
    pub investor: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = investor_shares_account.mint == vault.shares_mint,
        constraint = investor_shares_account.owner == investment_request.investor @ VaultError::Unauthorized,
    )]
    pub investor_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: FrozenAccount PDA — validated in handler
    #[account(
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), investment_request.investor.as_ref()],
        bump
    )]
    pub frozen_account: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handler(ctx: Context<ApproveDeposit>) -> Result<()> {
    require!(
        ctx.accounts.investment_request.status == RequestStatus::Pending,
        VaultError::RequestNotPending
    );

    let vault = &ctx.accounts.vault;

    // Re-validate attestation at approval time
    let clock = Clock::get()?;
    validate_attestation(
        ctx.remaining_accounts,
        &vault.attestation_program,
        &ctx.accounts.investment_request.investor,
        &vault.attester,
        &clock,
    )?;

    // Check not frozen
    check_not_frozen(&ctx.accounts.frozen_account.to_account_info())?;

    // Oracle is REQUIRED for SVS-11 (no fallback to vault-priced)
    let (price, updated_at) = find_oracle_price(
        ctx.remaining_accounts,
        &vault.oracle_program,
        &vault.nav_oracle,
    )?
    .ok_or(VaultError::OracleRequired)?;

    svs_oracle::validate_oracle(price, updated_at, clock.unix_timestamp, vault.max_staleness)
        .map_err(|e| match e {
            svs_oracle::OracleError::StalePrice => VaultError::StaleOraclePrice,
            svs_oracle::OracleError::InvalidPrice => VaultError::InvalidOraclePrice,
            svs_oracle::OracleError::MathOverflow => VaultError::MathOverflow,
            svs_oracle::OracleError::UnauthorizedUpdate => VaultError::Unauthorized,
            svs_oracle::OracleError::PriceDeviationExceeded => VaultError::InvalidOraclePrice,
        })?;

    let amount_locked = ctx.accounts.investment_request.amount_locked;

    // shares = amount_locked * 10^share_decimals / nav_per_share (floor)
    let gross_shares = svs_oracle::assets_to_shares(amount_locked, price).map_err(|e| match e {
        svs_oracle::OracleError::MathOverflow => VaultError::MathOverflow,
        _ => VaultError::InvalidOraclePrice,
    })?;

    // Apply module hooks if enabled
    #[cfg(feature = "modules")]
    let shares = {
        let remaining = ctx.remaining_accounts;
        let investor_key = ctx.accounts.investment_request.investor;
        let vk = vault.key();

        module_hooks::check_deposit_access(remaining, &crate::ID, &vk, &investor_key, &[])?;
        module_hooks::check_deposit_caps(
            remaining,
            &crate::ID,
            &vk,
            &investor_key,
            vault.total_assets,
            amount_locked,
        )?;

        let result = module_hooks::apply_entry_fee(remaining, &crate::ID, &vk, gross_shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    let shares = gross_shares;

    require!(shares > 0, VaultError::ZeroAmount);

    // Mint shares directly to investor's ATA (1-step approval)
    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        CREDIT_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[vault_bump],
    ]];

    token_2022::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.investor_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares,
    )?;

    // Update vault totals
    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_add(amount_locked)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_add(shares)
        .ok_or(VaultError::MathOverflow)?;

    // Update request and close (via close = investor constraint)
    let request = &mut ctx.accounts.investment_request;
    request.shares_to_receive = shares;
    request.status = RequestStatus::Approved;

    emit!(InvestmentApproved {
        vault: vault.key(),
        investor: request.investor,
        amount: amount_locked,
        shares,
        nav: price,
    });

    Ok(())
}
