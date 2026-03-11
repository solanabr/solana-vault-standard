//! distribute_yield instruction: authority starts a new yield stream.
//!
//! Transfers yield tokens from the authority's source account into the asset vault
//! and configures a new linear streaming period. If a stream is already active,
//! the current accrued yield is checkpointed first before the new stream begins.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::{MIN_STREAM_DURATION, STREAM_VAULT_SEED},
    error::VaultError,
    events::YieldStreamStarted,
    math::effective_total_assets,
    state::StreamVault,
};

#[derive(Accounts)]
pub struct DistributeYield<'info> {
    #[account(
        mut,
        seeds = [STREAM_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = authority @ VaultError::Unauthorized,
        has_one = asset_vault,
    )]
    pub vault: Account<'info, StreamVault>,

    #[account(mut)]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    /// Asset mint — required by transfer_checked
    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// Source of yield tokens (authority's ATA or external protocol account)
    #[account(
        mut,
        token::mint = vault.asset_mint,
        constraint = yield_source.key() != asset_vault.key() @ VaultError::Unauthorized,
    )]
    pub yield_source: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Start a new yield stream.
///
/// The authority deposits `yield_amount` tokens into the asset_vault and sets
/// the streaming period. If a previous stream is still active, accrued yield
/// is finalized into base_assets first (auto-checkpoint).
///
/// Parameters:
/// - `yield_amount`: number of tokens to stream (must be > 0)
/// - `duration`: stream duration in seconds (must be >= 60)
pub fn handler(
    ctx: Context<DistributeYield>,
    yield_amount: u64,
    duration: i64,
) -> Result<()> {
    require!(yield_amount > 0, VaultError::ZeroAmount);
    require!(duration >= MIN_STREAM_DURATION, VaultError::StreamTooShort);

    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // If a stream is currently active, auto-checkpoint to finalize ALL remaining
    // yield (both accrued and un-elapsed) into base_assets before starting new stream.
    // The old stream's un-elapsed tokens are already in asset_vault, so they must be
    // reflected in base_assets to prevent stranding.
    if now < vault.stream_end && vault.stream_amount > 0 {
        let effective = effective_total_assets(vault, now)?;
        let accrued = effective
            .checked_sub(vault.base_assets)
            .ok_or(VaultError::MathOverflow)?;

        // Absorb accrued yield into base_assets
        vault.base_assets = vault
            .base_assets
            .checked_add(accrued)
            .ok_or(VaultError::MathOverflow)?;
        // Also absorb the un-elapsed residual — those tokens are in asset_vault
        let residual = vault
            .stream_amount
            .checked_sub(accrued)
            .ok_or(VaultError::MathOverflow)?;
        vault.base_assets = vault
            .base_assets
            .checked_add(residual)
            .ok_or(VaultError::MathOverflow)?;
        vault.stream_amount = 0;
        vault.last_checkpoint = now;
    }

    // Transfer yield tokens from source to asset_vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.yield_source.to_account_info(),
                to: ctx.accounts.asset_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        yield_amount,
        ctx.accounts.asset_mint.decimals,
    )?;

    // Initialize new stream parameters
    vault.stream_amount = yield_amount;
    vault.stream_start = now;
    vault.stream_end = now
        .checked_add(duration)
        .ok_or(VaultError::MathOverflow)?;
    vault.last_checkpoint = now;

    emit!(YieldStreamStarted {
        vault: vault.key(),
        amount: yield_amount,
        duration,
        start: now,
        end: vault.stream_end,
    });

    Ok(())
}
