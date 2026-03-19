//! Reward instructions: fund_rewards, claim_rewards.
//!
//! SECURITY FIXES implemented:
//! 1. claim_rewards: Users can only claim their own rewards (owner verification)
//! 2. fund_rewards: Only reward authority can fund rewards
//! 3. Proper PDA derivation and validation for reward accounts
//!
//! This module is only available when the "modules" feature is enabled.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{Token2022, Transfer},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::error::VaultError;
use crate::state::{RewardConfig, UserReward};

// Seed constants for PDA derivation
const REWARD_CONFIG_SEED: &[u8] = b"reward_config";
const USER_REWARD_SEED: &[u8] = b"user_reward";

/// Claim rewards context - accounts for claiming user rewards
#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    /// The user claiming their rewards - must sign the transaction
    pub user: Signer<'info>,

    /// The vault account
    #[account(
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, crate::state::ConfidentialVault>,

    /// Reward mint (e.g., USDC)
    pub reward_mint: InterfaceAccount<'info, Mint>,

    /// Reward vault PDA - holds the reward tokens
    #[account(
        mut,
        seeds = [REWARD_CONFIG_SEED, vault.key().as_ref(), reward_mint.key().as_ref()],
        bump = reward_config.bump,
        has_one = vault @ VaultError::InvalidRewardConfig,
        has_one = reward_mint @ VaultError::InvalidRewardConfig,
    )]
    pub reward_config: Account<'info, RewardConfig>,

    /// User's reward account - tracks pending rewards
    /// SECURITY FIX: Validate that this belongs to the signing user
    #[account(
        mut,
        seeds = [USER_REWARD_SEED, vault.key().as_ref(), reward_mint.key().as_ref(), user.key().as_ref()],
        bump = user_reward.bump,
        has_one = vault @ VaultError::InvalidRewardConfig,
        has_one = user @ VaultError::Unauthorized,
    )]
    pub user_reward: Account<'info, UserReward>,

    /// User's reward token account (ATA) - where claimed tokens go
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = reward_mint,
        associated_token::authority = user,
        associated_token::token_program = reward_token_program,
    )]
    pub user_reward_account: InterfaceAccount<'info, TokenAccount>,

    /// Vault's reward token account (PDA) - holds rewards for distribution
    #[account(
        mut,
        constraint = reward_vault.key() == reward_config.reward_vault @ VaultError::InvalidRewardVault,
    )]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,

    pub reward_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Fund rewards context - authority adds rewards to the pool
#[derive(Accounts)]
pub struct FundRewards<'info> {
    /// The reward authority - must be the designated reward authority
    #[account(
        constraint = authority.key() == reward_config.reward_authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    /// The vault account
    #[account(
        constraint = vault.key() == reward_config.vault @ VaultError::InvalidRewardConfig,
    )]
    pub vault: Account<'info, crate::state::ConfidentialVault>,

    /// Reward mint
    pub reward_mint: InterfaceAccount<'info, Mint>,

    /// Reward config PDA
    #[account(
        mut,
        seeds = [REWARD_CONFIG_SEED, vault.key().as_ref(), reward_mint.key().as_ref()],
        bump = reward_config.bump,
        has_one = vault @ VaultError::InvalidRewardConfig,
        has_one = reward_mint @ VaultError::InvalidRewardConfig,
        has_one = reward_authority @ VaultError::InvalidRewardConfig,
    )]
    pub reward_config: Account<'info, RewardConfig>,

    /// User's reward token account - source of funds
    #[account(
        mut,
        constraint = user_reward_token.mint == reward_mint.key() @ VaultError::InvalidTokenAccount,
        constraint = user_reward_token.owner == authority.key() @ VaultError::Unauthorized,
    )]
    pub user_reward_token: InterfaceAccount<'info, TokenAccount>,

    /// Vault's reward token account (PDA)
    #[account(
        mut,
        constraint = reward_vault.key() == reward_config.reward_vault @ VaultError::InvalidRewardVault,
    )]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,

    pub reward_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
}

/// Claim pending rewards
///
/// SECURITY FIX: Users can only claim their own rewards.
/// The instruction validates:
/// 1. User is the owner of the user_reward account (via has_one constraint)
/// 2. User is the signer of the transaction
/// 3. Proper PDA derivation is validated
pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
    let user = ctx.accounts.user.key();
    let user_reward = &mut ctx.accounts.user_reward;
    let reward_config = &ctx.accounts.reward_config;
    let vault = &ctx.accounts.vault;

    // Calculate pending rewards using MasterChef formula
    // Note: In production, you'd use svs_rewards::calculate_pending_rewards
    // For now, we calculate: pending = user_shares * acc_per_share - debt + unclaimed
    // Since we don't have direct share access, we use the stored debt and unclaimed

    // Get current timestamp for accrual
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp;

    // Update accumulated per share if time has passed
    let time_elapsed = current_time.saturating_sub(reward_config.last_update);
    
    // For this simplified version, we calculate pending as:
    // The actual implementation would call svs_rewards::calculate_pending_rewards
    // Here we just use the unclaimed amount + any newly accrued
    let pending = user_reward.unclaimed;

    // Validate user has pending rewards
    require!(pending > 0, VaultError::InsufficientRewards);

    // Reset unclaimed after claim
    user_reward.unclaimed = 0;

    // Update reward debt to current accumulated
    // In production: user_reward.reward_debt = calculate_scaled_debt(user_shares, acc_per_share)
    user_reward.reward_debt = reward_config.accumulated_per_share;

    // Transfer rewards from vault to user
    let reward_vault = &mut ctx.accounts.reward_vault;
    let user_account = &mut ctx.accounts.user_reward_account;

    require!(
        reward_vault.amount >= pending,
        VaultError::InsufficientRewards
    );

    // Transfer the rewards
    anchor_spl::token_2022::transfer(
        CpiContext::new(
            ctx.accounts.reward_token_program.to_account_info(),
            Transfer {
                from: reward_vault.to_account_info(),
                to: user_account.to_account_info(),
                authority: reward_vault.to_account_info(),
            },
        ),
        pending,
    )?;

    msg!("User {} claimed {} rewards", user, pending);

    Ok(())
}

/// Fund rewards to the vault
///
/// SECURITY FIX: Only the designated reward authority can fund rewards.
/// This prevents unauthorized users from manipulating the reward pool.
pub fn fund_rewards(ctx: Context<FundRewards>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);

    let vault = &mut ctx.accounts.vault;
    let reward_config = &mut ctx.accounts.reward_config;
    let user_token = &ctx.accounts.user_reward_token;
    let reward_vault = &mut ctx.accounts.reward_vault;

    // Validate user has sufficient balance
    require!(
        user_token.amount >= amount,
        VaultError::InsufficientAssets
    );

    // Get total shares for reward distribution
    // In production, this would come from the shares mint supply
    let total_shares = vault.total_assets; // Using total_assets as proxy

    // Transfer tokens from user to vault
    anchor_spl::token_2022::transfer(
        CpiContext::new(
            ctx.accounts.reward_token_program.to_account_info(),
            Transfer {
                from: user_token.to_account_info(),
                to: reward_vault.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        amount,
    )?;

    // Update accumulated per share
    // Formula: new_acc = old_acc + (amount * PRECISION / total_shares)
    const PRECISION: u128 = 1_000_000_000_000_000_000; // 1e18
    
    if total_shares > 0 {
        let increase = (amount as u128)
            .checked_mul(PRECISION)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(total_shares as u128)
            .ok_or(VaultError::MathOverflow)?;
            
        reward_config.accumulated_per_share = reward_config
            .accumulated_per_share
            .checked_add(increase)
            .ok_or(VaultError::MathOverflow)?;
    }

    // Update last update timestamp
    let clock = Clock::get()?;
    reward_config.last_update = clock.unix_timestamp;

    msg!("Funded {} rewards to vault", amount);

    Ok(())
}
