//! Module administration instructions stub.

use anchor_lang::prelude::*;

use crate::error::VaultError;
use crate::state::AccessMode;
use crate::state::{
    AccessConfig, AsyncVault, CapConfig, FeeConfig, LockConfig, ACCESS_CONFIG_SEED,
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
    pub vault: Account<'info, AsyncVault>,

    #[account(
        init,
        payer = authority,
        space = FeeConfig::LEN,
        seeds = [FEE_CONFIG_SEED, vault.key().as_ref()],
        bump,
    )]
    pub fee_config: Account<'info, FeeConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateFeeConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        seeds = [FEE_CONFIG_SEED, vault.key().as_ref()],
        bump = fee_config.bump,
    )]
    pub fee_config: Account<'info, FeeConfig>,
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
    pub vault: Account<'info, AsyncVault>,

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

#[derive(Accounts)]
pub struct UpdateCapConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        seeds = [CAP_CONFIG_SEED, vault.key().as_ref()],
        bump = cap_config.bump,
    )]
    pub cap_config: Account<'info, CapConfig>,
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
    pub vault: Account<'info, AsyncVault>,

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

#[derive(Accounts)]
pub struct UpdateLockConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        seeds = [LOCK_CONFIG_SEED, vault.key().as_ref()],
        bump = lock_config.bump,
    )]
    pub lock_config: Account<'info, LockConfig>,
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
    pub vault: Account<'info, AsyncVault>,

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

#[derive(Accounts)]
pub struct UpdateAccessConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        seeds = [ACCESS_CONFIG_SEED, vault.key().as_ref()],
        bump = access_config.bump,
    )]
    pub access_config: Account<'info, AccessConfig>,
}

// =============================================================================
// Handler Functions
// =============================================================================

pub fn initialize_fee_config(
    _ctx: Context<InitializeFeeConfig>,
    _entry_fee_bps: u16,
    _exit_fee_bps: u16,
    _management_fee_bps: u16,
    _performance_fee_bps: u16,
) -> Result<()> {
    Ok(())
}

pub fn update_fee_config(
    _ctx: Context<UpdateFeeConfig>,
    _entry_fee_bps: Option<u16>,
    _exit_fee_bps: Option<u16>,
    _management_fee_bps: Option<u16>,
    _performance_fee_bps: Option<u16>,
) -> Result<()> {
    Ok(())
}

pub fn initialize_cap_config(
    _ctx: Context<InitializeCapConfig>,
    _global_cap: u64,
    _per_user_cap: u64,
) -> Result<()> {
    Ok(())
}

pub fn update_cap_config(
    _ctx: Context<UpdateCapConfig>,
    _global_cap: Option<u64>,
    _per_user_cap: Option<u64>,
) -> Result<()> {
    Ok(())
}

pub fn initialize_lock_config(
    _ctx: Context<InitializeLockConfig>,
    _lock_duration: i64,
) -> Result<()> {
    Ok(())
}

pub fn update_lock_config(_ctx: Context<UpdateLockConfig>, _lock_duration: i64) -> Result<()> {
    Ok(())
}

pub fn initialize_access_config(
    _ctx: Context<InitializeAccessConfig>,
    _mode: AccessMode,
    _merkle_root: [u8; 32],
) -> Result<()> {
    Ok(())
}

pub fn update_access_config(
    _ctx: Context<UpdateAccessConfig>,
    _mode: Option<AccessMode>,
    _merkle_root: Option<[u8; 32]>,
) -> Result<()> {
    Ok(())
}
