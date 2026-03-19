//! Distribute-yield instruction: transfer native SOL to vault and start stream.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::{
    constants::{MIN_STREAM_DURATION_SECONDS, VAULT_SEED},
    error::VaultError,
    events::YieldStreamStarted,
    math::checkpoint_stream,
    state::NativeSolStreamVault,
};

#[derive(Accounts)]
pub struct DistributeYield<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = authority
    )]
    pub vault: Account<'info, NativeSolStreamVault>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DistributeYield>, yield_amount: u64, duration: i64) -> Result<()> {
    require!(yield_amount > 0, VaultError::ZeroAmount);
    require!(
        duration >= MIN_STREAM_DURATION_SECONDS,
        VaultError::StreamTooShort
    );

    let now = Clock::get()?.unix_timestamp;
    {
        let vault = &mut ctx.accounts.vault;
        checkpoint_stream(vault, now)?;
    }

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        yield_amount,
    )?;

    let vault = &mut ctx.accounts.vault;
    vault.stream_amount = yield_amount;
    vault.stream_start = now;
    vault.stream_end = now.checked_add(duration).ok_or(VaultError::MathOverflow)?;
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
