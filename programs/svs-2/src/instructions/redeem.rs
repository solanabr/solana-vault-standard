use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::{
    token_2022::{self, Burn, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};
use bytemuck::try_from_bytes;
use solana_zk_sdk::encryption::pod::auth_encryption::PodAeCiphertext;
use spl_token_2022::extension::confidential_transfer::instruction::inner_withdraw;
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;

use crate::{
    constants::{SHARES_DECIMALS, VAULT_SEED},
    error::VaultError,
    events::Withdraw as WithdrawEvent,
    math::{convert_to_assets, Rounding},
    state::ConfidentialVault,
};

/// Redeem confidential shares for assets
///
/// Requires pre-verified proof context accounts for:
/// - CiphertextCommitmentEqualityProof
/// - BatchedRangeProofU64
///
/// These proofs must be verified using the ZK ElGamal program before calling redeem.
#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, ConfidentialVault>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_asset_account.mint == vault.asset_mint,
        constraint = user_asset_account.owner == user.key(),
    )]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Pre-verified CiphertextCommitmentEqualityProof context state account
    pub equality_proof_context: UncheckedAccount<'info>,

    /// CHECK: Pre-verified BatchedRangeProofU64 context state account
    pub range_proof_context: UncheckedAccount<'info>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
}

/// Redeem shares for assets (floor rounding - protects vault)
///
/// # Arguments
/// * `shares` - Number of confidential shares to redeem
/// * `min_assets_out` - Minimum assets to receive (slippage protection)
/// * `new_decryptable_available_balance` - AE ciphertext of balance after withdrawal
///   (computed client-side: current_balance - shares)
pub fn handler(
    ctx: Context<Redeem>,
    shares: u64,
    min_assets_out: u64,
    new_decryptable_available_balance: [u8; 36],
) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;

    // Calculate assets to receive (floor rounding - user gets less)
    let assets = convert_to_assets(
        shares,
        vault.total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    // Slippage check
    require!(assets >= min_assets_out, VaultError::SlippageExceeded);

    // Check vault has enough assets
    require!(assets <= vault.total_assets, VaultError::InsufficientAssets);

    // Convert bytes to PodAeCiphertext (safe conversion)
    let new_decryptable_balance: PodAeCiphertext =
        *try_from_bytes::<PodAeCiphertext>(&new_decryptable_available_balance)
            .map_err(|_| VaultError::InvalidCiphertext)?;

    // Step 1: Withdraw from confidential to non-confidential balance
    let withdraw_ix = inner_withdraw(
        &ctx.accounts.token_2022_program.key(),
        &ctx.accounts.user_shares_account.key(),
        &ctx.accounts.shares_mint.key(),
        shares,
        SHARES_DECIMALS,
        new_decryptable_balance,
        &ctx.accounts.user.key(),
        &[],
        ProofLocation::ContextStateAccount(ctx.accounts.equality_proof_context.key),
        ProofLocation::ContextStateAccount(ctx.accounts.range_proof_context.key),
    )?;

    invoke(
        &withdraw_ix,
        &[
            ctx.accounts.user_shares_account.to_account_info(),
            ctx.accounts.shares_mint.to_account_info(),
            ctx.accounts.equality_proof_context.to_account_info(),
            ctx.accounts.range_proof_context.to_account_info(),
            ctx.accounts.user.to_account_info(),
        ],
    )?;

    // Step 2: Burn shares from user's non-confidential balance
    token_2022::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.to_account_info(),
            Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
    )?;

    // Step 3: Transfer assets from vault to user
    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.asset_vault.to_account_info(),
                to: ctx.accounts.user_asset_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    // Update cached total assets
    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_sub(assets)
        .ok_or(VaultError::MathOverflow)?;

    emit!(WithdrawEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        receiver: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets,
        shares,
    });

    Ok(())
}
