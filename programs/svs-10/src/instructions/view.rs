//! View instructions: read-only queries for async vault state.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token_interface::Mint;

use crate::{
    constants::{CLAIMABLE_SEED, DEPOSIT_REQUEST_SEED, REDEEM_REQUEST_SEED},
    math::{convert_to_assets, convert_to_shares, Rounding},
    state::{AsyncVault, ClaimableEscrow, DepositRequest, RedeemRequest, RequestStatus},
};

// =============================================================================
// Basic vault view context
// =============================================================================

#[derive(Accounts)]
pub struct VaultView<'info> {
    pub vault: Account<'info, AsyncVault>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,
}

#[derive(Accounts)]
pub struct VaultViewWithOwner<'info> {
    pub vault: Account<'info, AsyncVault>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,
}

// =============================================================================
// ERC-7540 async-specific view functions
// =============================================================================

/// Returns assets_locked if owner has a Pending deposit, else 0.
/// Maps to ERC-7540 pendingDepositRequest(controller).
#[derive(Accounts)]
pub struct PendingDepositView<'info> {
    pub vault: Account<'info, AsyncVault>,

    /// CHECK: owner pubkey passed for PDA derivation
    pub owner: UncheckedAccount<'info>,

    #[account(
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = deposit_request.bump,
    )]
    pub deposit_request: Account<'info, DepositRequest>,
}

pub fn pending_deposit_request(ctx: Context<PendingDepositView>) -> Result<()> {
    let amount = if ctx.accounts.deposit_request.status == RequestStatus::Pending {
        ctx.accounts.deposit_request.assets_locked
    } else {
        0u64
    };
    set_return_data(&amount.to_le_bytes());
    Ok(())
}

/// Returns shares_claimable if owner has a Fulfilled deposit, else 0.
/// Maps to ERC-7540 claimableDepositRequest(controller).
#[derive(Accounts)]
pub struct ClaimableDepositView<'info> {
    pub vault: Account<'info, AsyncVault>,

    /// CHECK: owner pubkey for PDA derivation
    pub owner: UncheckedAccount<'info>,

    #[account(
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = deposit_request.bump,
    )]
    pub deposit_request: Account<'info, DepositRequest>,
}

pub fn claimable_deposit_request(ctx: Context<ClaimableDepositView>) -> Result<()> {
    let amount = if ctx.accounts.deposit_request.status == RequestStatus::Fulfilled {
        ctx.accounts.deposit_request.shares_claimable
    } else {
        0u64
    };
    set_return_data(&amount.to_le_bytes());
    Ok(())
}

/// Returns shares_locked if owner has a Pending redeem request, else 0.
/// Maps to ERC-7540 pendingRedeemRequest(controller).
#[derive(Accounts)]
pub struct PendingRedeemView<'info> {
    pub vault: Account<'info, AsyncVault>,

    /// CHECK: owner pubkey for PDA derivation
    pub owner: UncheckedAccount<'info>,

    #[account(
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = redeem_request.bump,
    )]
    pub redeem_request: Account<'info, RedeemRequest>,
}

pub fn pending_redeem_request(ctx: Context<PendingRedeemView>) -> Result<()> {
    let amount = if ctx.accounts.redeem_request.status == RequestStatus::Pending {
        ctx.accounts.redeem_request.shares_locked
    } else {
        0u64
    };
    set_return_data(&amount.to_le_bytes());
    Ok(())
}

/// Returns amount from ClaimableEscrow if it exists for this owner, else 0.
/// Maps to ERC-7540 claimableRedeemRequest(controller).
#[derive(Accounts)]
pub struct ClaimableRedeemView<'info> {
    pub vault: Account<'info, AsyncVault>,

    /// CHECK: owner pubkey for PDA derivation
    pub owner: UncheckedAccount<'info>,

    #[account(
        seeds = [CLAIMABLE_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = claimable_escrow.bump,
    )]
    pub claimable_escrow: Account<'info, ClaimableEscrow>,
}

pub fn claimable_redeem_request(ctx: Context<ClaimableRedeemView>) -> Result<()> {
    set_return_data(&ctx.accounts.claimable_escrow.amount.to_le_bytes());
    Ok(())
}

// =============================================================================
// ERC-4626 standard view functions (using stored total_assets/total_shares)
// =============================================================================

/// Preview shares for deposit (floor rounding)
pub fn preview_deposit(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = vault.total_assets;

    let shares = convert_to_shares(
        assets,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    set_return_data(&shares.to_le_bytes());
    Ok(())
}

/// Preview assets required to mint exact shares (ceiling rounding)
pub fn preview_mint(ctx: Context<VaultView>, shares: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = vault.total_assets;

    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Ceiling,
    )?;

    set_return_data(&assets.to_le_bytes());
    Ok(())
}

/// Preview shares to burn for exact asset withdrawal (ceiling rounding)
pub fn preview_withdraw(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = vault.total_assets;

    let shares = convert_to_shares(
        assets,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Ceiling,
    )?;

    set_return_data(&shares.to_le_bytes());
    Ok(())
}

/// Preview assets for redeem (floor rounding)
pub fn preview_redeem(ctx: Context<VaultView>, shares: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = vault.total_assets;

    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    set_return_data(&assets.to_le_bytes());
    Ok(())
}

/// Convert assets to shares (floor rounding)
pub fn convert_to_shares_view(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = vault.total_assets;

    let shares = convert_to_shares(
        assets,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    set_return_data(&shares.to_le_bytes());
    Ok(())
}

/// Convert shares to assets (floor rounding)
pub fn convert_to_assets_view(ctx: Context<VaultView>, shares: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = vault.total_assets;

    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    set_return_data(&assets.to_le_bytes());
    Ok(())
}

/// Get total assets managed by the vault (stored balance)
pub fn get_total_assets(ctx: Context<VaultView>) -> Result<()> {
    set_return_data(&ctx.accounts.vault.total_assets.to_le_bytes());
    Ok(())
}

/// Async vault: max_deposit returns 0 — use request_deposit instead
pub fn max_deposit(ctx: Context<VaultView>) -> Result<()> {
    // Async vaults do not support atomic deposits. Return 0.
    let _ = ctx;
    set_return_data(&0u64.to_le_bytes());
    Ok(())
}

/// Async vault: max_mint returns 0 — use request_deposit instead
pub fn max_mint(ctx: Context<VaultView>) -> Result<()> {
    let _ = ctx;
    set_return_data(&0u64.to_le_bytes());
    Ok(())
}

/// Async vault: max_withdraw returns 0 — use request_redeem instead
pub fn max_withdraw(ctx: Context<VaultViewWithOwner>) -> Result<()> {
    let _ = ctx;
    set_return_data(&0u64.to_le_bytes());
    Ok(())
}

/// Async vault: max_redeem returns 0 — use request_redeem instead
pub fn max_redeem(ctx: Context<VaultViewWithOwner>) -> Result<()> {
    let _ = ctx;
    set_return_data(&0u64.to_le_bytes());
    Ok(())
}
