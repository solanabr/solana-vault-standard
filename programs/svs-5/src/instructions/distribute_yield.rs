//! Distribute yield instruction: start a new streaming yield distribution.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::MIN_STREAM_DURATION,
    error::VaultError,
    events::{Checkpointed, YieldStreamStarted},
    state::StreamVault,
};

#[derive(Accounts)]
pub struct DistributeYield<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, StreamVault>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = authority_asset_account.mint == vault.asset_mint,
        constraint = authority_asset_account.owner == authority.key(),
    )]
    pub authority_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<DistributeYield>, yield_amount: u64, duration: i64) -> Result<()> {
    require!(yield_amount > 0, VaultError::ZeroAmount);
    require!(duration >= MIN_STREAM_DURATION, VaultError::StreamTooShort);

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let vault = &mut ctx.accounts.vault;

    // Auto-checkpoint if an active stream exists
    let accrued = vault.checkpoint(now)?;
    if accrued > 0 {
        emit!(Checkpointed {
            vault: vault.key(),
            accrued,
            new_base_assets: vault.base_assets,
            timestamp: now,
        });
    }

    // Recognize any remaining un-accrued yield from previous stream.
    // After checkpoint, stream_amount holds the un-accrued remainder.
    // These tokens are already in the vault — reflect them in base_assets
    // so they aren't lost when stream_amount is overwritten below.
    if vault.stream_amount > 0 {
        vault.base_assets = vault
            .base_assets
            .checked_add(vault.stream_amount)
            .ok_or(VaultError::MathOverflow)?;
        vault.stream_amount = 0;
    }

    // Transfer yield tokens from authority to asset vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.authority_asset_account.to_account_info(),
                to: ctx.accounts.asset_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        yield_amount,
        ctx.accounts.asset_mint.decimals,
    )?;

    // Set new stream state
    let stream_end = now.checked_add(duration).ok_or(VaultError::MathOverflow)?;

    vault.stream_amount = yield_amount;
    vault.stream_start = now;
    vault.stream_end = stream_end;

    emit!(YieldStreamStarted {
        vault: vault.key(),
        amount: yield_amount,
        duration,
        start: now,
        end: stream_end,
    });

    Ok(())
}
