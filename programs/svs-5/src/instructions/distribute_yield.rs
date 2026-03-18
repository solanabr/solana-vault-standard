//! Distribute yield instruction: transfer yield tokens to vault and start streaming.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::VAULT_SEED,
    error::VaultError,
    events::YieldStreamStarted,
    math::effective_total_assets,
    state::StreamVault,
};

#[derive(Accounts)]
pub struct DistributeYield<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = authority,
        has_one = asset_vault
    )]
    pub vault: Account<'info, StreamVault>,
    
    pub asset_mint: InterfaceAccount<'info, Mint>,
    
    #[account(mut)]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,
    
    #[account(mut, token::mint = vault.asset_mint)]
    pub yield_source: InterfaceAccount<'info, TokenAccount>,
    
    pub authority: Signer<'info>,
    
    pub asset_token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<DistributeYield>, yield_amount: u64, duration: i64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    require!(yield_amount > 0, VaultError::ZeroAmount);
    require!(duration >= 60, VaultError::StreamTooShort);

    // Auto-checkpoint if stream is active
    if now < vault.stream_end && vault.stream_amount > 0 {
        let effective = effective_total_assets(vault, now)?;
        let accrued = effective
            .checked_sub(vault.base_assets)
            .ok_or(VaultError::MathOverflow)?;
        vault.base_assets = vault.base_assets.checked_add(accrued).ok_or(VaultError::MathOverflow)?;
        vault.stream_amount = 0;
    }

    // Transfer yield tokens from source to vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.asset_token_program.to_account_info(),
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

    // Initialize new stream
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
