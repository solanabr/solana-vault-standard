//! Apply pending instruction: move confidential pending balance to available balance.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount};
use bytemuck::try_from_bytes;
use solana_zk_sdk::encryption::pod::auth_encryption::PodAeCiphertext;
use spl_token_2022::extension::confidential_transfer::instruction::apply_pending_balance;

use crate::error::VaultError;
use crate::events::PendingApplied;
use crate::state::ConfidentialStreamVault;

/// Apply pending balance to available balance.
/// Must be called after deposit/mint before shares can be used.
///
/// The user must compute new_decryptable_available_balance client-side:
/// 1. Decrypt pending balance using their ElGamal key
/// 2. Add to current available balance
/// 3. Re-encrypt with their AES key
#[derive(Accounts)]
pub struct ApplyPending<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub vault: Account<'info, ConfidentialStreamVault>,

    /// Shares mint — for validation
    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handler(
    ctx: Context<ApplyPending>,
    new_decryptable_available_balance: [u8; 36],
    expected_pending_balance_credit_counter: u64,
) -> Result<()> {
    let user = &ctx.accounts.user;
    let user_shares_account = &ctx.accounts.user_shares_account;

    // Convert bytes to PodAeCiphertext
    let new_decryptable_balance: PodAeCiphertext =
        *try_from_bytes::<PodAeCiphertext>(&new_decryptable_available_balance)
            .map_err(|_| VaultError::InvalidCiphertext)?;

    // CPI to Token-2022 apply_pending_balance
    let apply_pending_ix = apply_pending_balance(
        &ctx.accounts.token_2022_program.key(),
        &user_shares_account.key(),
        expected_pending_balance_credit_counter,
        new_decryptable_balance,
        &user.key(),
        &[],
    )?;

    invoke(
        &apply_pending_ix,
        &[
            user_shares_account.to_account_info(),
            user.to_account_info(),
        ],
    )?;

    emit!(PendingApplied {
        vault: ctx.accounts.vault.key(),
        user: user.key(),
    });

    msg!("Applied pending balance for user: {}", user.key());

    Ok(())
}
