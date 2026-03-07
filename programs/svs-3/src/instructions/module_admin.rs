//! Module administration instructions.
//!
//! These instructions allow vault admins to configure optional modules:
//! - Fees (entry, exit, management, performance)
//! - Caps (global and per-user deposit limits)
//! - Locks (time-locked shares)
//! - Access (whitelist/blacklist)

use anchor_lang::prelude::*;

use crate::error::VaultError;
use crate::state::AccessMode;
use crate::state::{
    AccessConfig, CapConfig, ConfidentialVault, FeeConfig, LockConfig, ACCESS_CONFIG_SEED,
    CAP_CONFIG_SEED, FEE_CONFIG_SEED, LOCK_CONFIG_SEED,
};

// =============================================================================
// Fee Config Instructions
// =============================================================================

#[derive(Accounts)]
pub struct InitializeFeeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, ConfidentialVault>,

    #[account(
        init,
        payer = authority,
        space = FeeConfig::LEN,
        seeds = [FEE_CONFIG_SEED, vault.key().as_ref()],
        bump,
    )]
    pub fee_config: Account<'info, FeeConfig>,

    /// Fee recipient account
    /// CHECK: Any valid pubkey can receive fees
    pub fee_recipient: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_fee_config(
    ctx: Context<InitializeFeeConfig>,
    entry_fee_bps: u16,
    exit_fee_bps: u16,
    management_fee_bps: u16,
    performance_fee_bps: u16,
) -> Result<()> {
    // Validate fees using module
    svs_fees::validate_fee_config(
        entry_fee_bps,
        exit_fee_bps,
        management_fee_bps,
        performance_fee_bps,
    )
    .map_err(|_| VaultError::EntryFeeExceedsMax)?;

    let fee_config = &mut ctx.accounts.fee_config;
    fee_config.vault = ctx.accounts.vault.key();
    fee_config.fee_recipient = ctx.accounts.fee_recipient.key();
    fee_config.entry_fee_bps = entry_fee_bps;
    fee_config.exit_fee_bps = exit_fee_bps;
    fee_config.management_fee_bps = management_fee_bps;
    fee_config.performance_fee_bps = performance_fee_bps;
    fee_config.high_water_mark = svs_fees::HWM_SCALE; // Start at 1.0
    fee_config.last_fee_collection = Clock::get()?.unix_timestamp;
    fee_config.bump = ctx.bumps.fee_config;

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateFeeConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, ConfidentialVault>,

    #[account(
        mut,
        seeds = [FEE_CONFIG_SEED, vault.key().as_ref()],
        bump = fee_config.bump,
        has_one = vault,
    )]
    pub fee_config: Account<'info, FeeConfig>,
}

pub fn update_fee_config(
    ctx: Context<UpdateFeeConfig>,
    entry_fee_bps: Option<u16>,
    exit_fee_bps: Option<u16>,
    management_fee_bps: Option<u16>,
    performance_fee_bps: Option<u16>,
) -> Result<()> {
    let fee_config = &mut ctx.accounts.fee_config;

    let new_entry = entry_fee_bps.unwrap_or(fee_config.entry_fee_bps);
    let new_exit = exit_fee_bps.unwrap_or(fee_config.exit_fee_bps);
    let new_mgmt = management_fee_bps.unwrap_or(fee_config.management_fee_bps);
    let new_perf = performance_fee_bps.unwrap_or(fee_config.performance_fee_bps);

    svs_fees::validate_fee_config(new_entry, new_exit, new_mgmt, new_perf)
        .map_err(|_| VaultError::EntryFeeExceedsMax)?;

    fee_config.entry_fee_bps = new_entry;
    fee_config.exit_fee_bps = new_exit;
    fee_config.management_fee_bps = new_mgmt;
    fee_config.performance_fee_bps = new_perf;

    Ok(())
}

// =============================================================================
// Cap Config Instructions
// =============================================================================

#[derive(Accounts)]
pub struct InitializeCapConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, ConfidentialVault>,

    #[account(
        init,
        payer = authority,
        space = CapConfig::LEN,
        seeds = [CAP_CONFIG_SEED, vault.key().as_ref()],
        bump,
    )]
    pub cap_config: Account<'info, CapConfig>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_cap_config(
    ctx: Context<InitializeCapConfig>,
    global_cap: u64,
    per_user_cap: u64,
) -> Result<()> {
    // Validate caps
    svs_caps::validate_cap_config(global_cap, per_user_cap)
        .map_err(|_| VaultError::GlobalCapExceeded)?;

    let cap_config = &mut ctx.accounts.cap_config;
    cap_config.vault = ctx.accounts.vault.key();
    cap_config.global_cap = global_cap;
    cap_config.per_user_cap = per_user_cap;
    cap_config.bump = ctx.bumps.cap_config;

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateCapConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, ConfidentialVault>,

    #[account(
        mut,
        seeds = [CAP_CONFIG_SEED, vault.key().as_ref()],
        bump = cap_config.bump,
        has_one = vault,
    )]
    pub cap_config: Account<'info, CapConfig>,
}

pub fn update_cap_config(
    ctx: Context<UpdateCapConfig>,
    global_cap: Option<u64>,
    per_user_cap: Option<u64>,
) -> Result<()> {
    let cap_config = &mut ctx.accounts.cap_config;

    let new_global = global_cap.unwrap_or(cap_config.global_cap);
    let new_per_user = per_user_cap.unwrap_or(cap_config.per_user_cap);

    svs_caps::validate_cap_config(new_global, new_per_user)
        .map_err(|_| VaultError::GlobalCapExceeded)?;

    cap_config.global_cap = new_global;
    cap_config.per_user_cap = new_per_user;

    Ok(())
}

// =============================================================================
// Lock Config Instructions
// =============================================================================

#[derive(Accounts)]
pub struct InitializeLockConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, ConfidentialVault>,

    #[account(
        init,
        payer = authority,
        space = LockConfig::LEN,
        seeds = [LOCK_CONFIG_SEED, vault.key().as_ref()],
        bump,
    )]
    pub lock_config: Account<'info, LockConfig>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_lock_config(
    ctx: Context<InitializeLockConfig>,
    lock_duration: i64,
) -> Result<()> {
    svs_locks::validate_lock_duration(lock_duration)
        .map_err(|_| VaultError::LockDurationExceedsMax)?;

    let lock_config = &mut ctx.accounts.lock_config;
    lock_config.vault = ctx.accounts.vault.key();
    lock_config.lock_duration = lock_duration;
    lock_config.bump = ctx.bumps.lock_config;

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateLockConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, ConfidentialVault>,

    #[account(
        mut,
        seeds = [LOCK_CONFIG_SEED, vault.key().as_ref()],
        bump = lock_config.bump,
        has_one = vault,
    )]
    pub lock_config: Account<'info, LockConfig>,
}

pub fn update_lock_config(ctx: Context<UpdateLockConfig>, lock_duration: i64) -> Result<()> {
    svs_locks::validate_lock_duration(lock_duration)
        .map_err(|_| VaultError::LockDurationExceedsMax)?;

    ctx.accounts.lock_config.lock_duration = lock_duration;

    Ok(())
}

// =============================================================================
// Access Config Instructions
// =============================================================================

#[derive(Accounts)]
pub struct InitializeAccessConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, ConfidentialVault>,

    #[account(
        init,
        payer = authority,
        space = AccessConfig::LEN,
        seeds = [ACCESS_CONFIG_SEED, vault.key().as_ref()],
        bump,
    )]
    pub access_config: Account<'info, AccessConfig>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_access_config(
    ctx: Context<InitializeAccessConfig>,
    mode: AccessMode,
    merkle_root: [u8; 32],
) -> Result<()> {
    let access_config = &mut ctx.accounts.access_config;
    access_config.vault = ctx.accounts.vault.key();
    access_config.mode = mode;
    access_config.merkle_root = merkle_root;
    access_config.bump = ctx.bumps.access_config;

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateAccessConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, ConfidentialVault>,

    #[account(
        mut,
        seeds = [ACCESS_CONFIG_SEED, vault.key().as_ref()],
        bump = access_config.bump,
        has_one = vault,
    )]
    pub access_config: Account<'info, AccessConfig>,
}

pub fn update_access_config(
    ctx: Context<UpdateAccessConfig>,
    mode: Option<AccessMode>,
    merkle_root: Option<[u8; 32]>,
) -> Result<()> {
    let access_config = &mut ctx.accounts.access_config;

    if let Some(m) = mode {
        access_config.mode = m;
    }
    if let Some(root) = merkle_root {
        access_config.merkle_root = root;
    }

    Ok(())
}
