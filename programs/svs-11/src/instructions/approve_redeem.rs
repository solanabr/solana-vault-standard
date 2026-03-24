use anchor_lang::prelude::*;
use anchor_spl::token_2022::{self, Token2022};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::attestation::validate_attestation;
use crate::constants::{
    CLAIMABLE_TOKENS_SEED, FROZEN_ACCOUNT_SEED, REDEMPTION_ESCROW_SEED, REDEMPTION_REQUEST_SEED,
    VAULT_SEED,
};
use crate::error::VaultError;
use crate::events::RedemptionApproved;
use crate::math;
use crate::oracle::read_and_validate_oracle;
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
    pub vault: Account<'info, CreditVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [REDEMPTION_REQUEST_SEED, vault.key().as_ref(), redemption_request.investor.as_ref()],
        bump = redemption_request.bump,
        constraint = redemption_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
    )]
    pub redemption_request: Account<'info, RedemptionRequest>,

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

    #[account(
        init,
        payer = manager,
        token::mint = asset_mint,
        token::authority = vault,
        token::token_program = asset_token_program,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub claimable_tokens: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Oracle account validated via read_and_validate_oracle
    pub nav_oracle: UncheckedAccount<'info>,

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

pub fn handler(ctx: Context<ApproveRedeem>) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
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

    let price = read_and_validate_oracle(
        &ctx.accounts.nav_oracle.to_account_info(),
        &ctx.accounts.vault,
        &ctx.accounts.clock,
    )?;

    let shares_locked = ctx.accounts.redemption_request.shares_locked;
    let gross_assets = math::shares_to_assets(shares_locked, price)?;

    #[cfg(feature = "modules")]
    let gross_assets = {
        let remaining = ctx.remaining_accounts;
        let vault_key = ctx.accounts.vault.key();
        let result = module_hooks::apply_exit_fee(remaining, &crate::ID, &vault_key, gross_assets)?;
        result.net_assets
    };

    require!(gross_assets > 0, VaultError::ZeroAmount);

    let available = ctx
        .accounts
        .deposit_vault
        .amount
        .checked_sub(ctx.accounts.vault.total_pending_deposits)
        .and_then(|v| v.checked_sub(ctx.accounts.vault.total_approved_deposits))
        .ok_or(VaultError::MathOverflow)?;
    require!(available >= gross_assets, VaultError::InsufficientLiquidity);

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
        gross_assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    let request = &mut ctx.accounts.redemption_request;
    request.status = RequestStatus::Approved;
    request.assets_claimable = gross_assets;
    request.fulfilled_at = ctx.accounts.clock.unix_timestamp;

    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_sub(gross_assets)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_sub(shares_locked)
        .ok_or(VaultError::MathOverflow)?;

    emit!(RedemptionApproved {
        vault: vault.key(),
        investor: ctx.accounts.investor.key(),
        shares: shares_locked,
        assets: gross_assets,
        nav: price,
    });

    Ok(())
}
