//! Redeem instruction: CT inner_withdraw, burn exact shares, transfer assets.
//! Uses streaming effective_total_assets for share price calculation.

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
    events::WithdrawEvent,
    math::{convert_to_assets, Rounding},
    state::ConfidentialStreamVault,
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

/// Redeem confidential shares for assets.
///
/// Requires pre-verified proof context accounts for:
/// - CiphertextCommitmentEqualityProof
/// - BatchedRangeProofU64
///
/// CRITICAL: Call checkpoint() in the same transaction before this instruction.
#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, ConfidentialStreamVault>,

    #[account(constraint = asset_mint.key() == vault.asset_mint)]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_asset_account.mint == vault.asset_mint,
        constraint = user_asset_account.owner == user.key(),
    )]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = asset_vault.key() == vault.asset_vault)]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Pre-verified CiphertextCommitmentEqualityProof context state account.
    #[account(
        constraint = equality_proof_context.owner == &solana_zk_sdk::zk_elgamal_proof_program::id()
            @ VaultError::InvalidProof,
    )]
    pub equality_proof_context: UncheckedAccount<'info>,

    /// CHECK: Pre-verified BatchedRangeProofU64 context state account.
    #[account(
        constraint = range_proof_context.owner == &solana_zk_sdk::zk_elgamal_proof_program::id()
            @ VaultError::InvalidProof,
    )]
    pub range_proof_context: UncheckedAccount<'info>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handler(
    ctx: Context<Redeem>,
    shares: u64,
    min_assets_out: u64,
    new_decryptable_available_balance: [u8; 36],
) -> Result<()> {
    // ── 1. VALIDATION ──
    require!(shares > 0, VaultError::ZeroAmount);

    // ── 2. READ STATE (streaming math) ──
    let vault = &ctx.accounts.vault;
    let clock = Clock::get()?;
    let total_assets = vault.effective_total_assets(clock.unix_timestamp)?;
    let total_shares = vault.total_shares;

    // ── 3. COMPUTE — floor rounding, user gets fewer assets ──
    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    // ── Module hooks ──
    #[cfg(feature = "modules")]
    let net_assets = {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let user_key = ctx.accounts.user.key();

        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;
        module_hooks::check_share_lock(
            remaining, &crate::ID, &vault_key, &user_key, clock.unix_timestamp,
        )?;
        let result = module_hooks::apply_exit_fee(remaining, &crate::ID, &vault_key, assets)?;
        result.net_assets
    };

    #[cfg(not(feature = "modules"))]
    let net_assets = assets;

    // ── 4. SLIPPAGE CHECK ──
    require!(net_assets >= min_assets_out, VaultError::SlippageExceeded);
    require!(assets <= total_assets, VaultError::InsufficientAssets);

    // ── 5. EXECUTE ──

    let new_decryptable_balance: PodAeCiphertext =
        *try_from_bytes::<PodAeCiphertext>(&new_decryptable_available_balance)
            .map_err(|_| VaultError::InvalidCiphertext)?;

    // Step 5a: CT inner_withdraw — confidential → non-confidential balance
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

    // Step 5b: Burn shares from non-confidential balance
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

    // Step 5c: Transfer assets — vault → user (vault PDA signs)
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
        net_assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    // ── 6. UPDATE STATE ──
    let vault = &mut ctx.accounts.vault;
    vault.base_assets = vault
        .base_assets
        .checked_sub(assets)
        .ok_or(VaultError::InsufficientAssets)?;
    vault.total_shares = vault
        .total_shares
        .checked_sub(shares)
        .ok_or(VaultError::InsufficientShares)?;

    // ── 7. EMIT EVENT ──
    emit!(WithdrawEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        receiver: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets: net_assets,
        shares,
    });

    Ok(())
}
