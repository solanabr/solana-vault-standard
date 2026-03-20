//! Module integration hooks for vault instructions.
//!
//! This module provides helper functions for integrating optional modules
//! with vault deposit/withdraw operations. Modules are detected by parsing
//! remaining_accounts for known PDA patterns.

use anchor_lang::prelude::*;

use crate::error::VaultError;
use crate::state::{
    AccessConfig, AccessMode, CapConfig, FeeConfig, LockConfig, ShareLock, UserDeposit,
    ACCESS_CONFIG_SEED, CAP_CONFIG_SEED, FEE_CONFIG_SEED, LOCK_CONFIG_SEED, SHARE_LOCK_SEED,
    USER_DEPOSIT_SEED,
};

/// Result of pre-deposit module checks.
pub struct DepositModuleResult {
    /// Shares after entry fee deduction
    pub net_shares: u64,
    /// Entry fee shares (to mint to fee recipient)
    pub fee_shares: u64,
    /// Fee recipient address (if fees enabled)
    pub fee_recipient: Option<Pubkey>,
}

/// Check access control for deposit.
pub fn check_deposit_access(
    remaining_accounts: &[AccountInfo],
    vault_key: &Pubkey,
    user_key: &Pubkey,
    merkle_proof: &[[u8; 32]],
) -> Result<()> {
    // Try to find and load access config
    let access_config = find_access_config(remaining_accounts, vault_key)?;

    if let Some(config) = access_config {
        // Convert state AccessMode to svs_access AccessMode
        let mode = match config.mode {
            AccessMode::Open => svs_access::AccessMode::Open,
            AccessMode::Whitelist => svs_access::AccessMode::Whitelist,
            AccessMode::Blacklist => svs_access::AccessMode::Blacklist,
        };

        let user_bytes = user_key.to_bytes();
        svs_access::check_access(mode, &config.merkle_root, &user_bytes, merkle_proof).map_err(
            |e| match e {
                svs_access::AccessError::NotWhitelisted => VaultError::NotWhitelisted,
                svs_access::AccessError::Blacklisted => VaultError::Blacklisted,
                svs_access::AccessError::AccountFrozen => VaultError::AccountFrozen,
                svs_access::AccessError::InvalidProof => VaultError::InvalidProof,
                _ => VaultError::InvalidProof,
            },
        )?;

        // Check if user is frozen
        let frozen = find_frozen_account(remaining_accounts, vault_key, user_key)?;
        if frozen {
            return Err(VaultError::AccountFrozen.into());
        }
    }

    Ok(())
}

/// Check deposit caps.
pub fn check_deposit_caps(
    remaining_accounts: &[AccountInfo],
    vault_key: &Pubkey,
    user_key: &Pubkey,
    total_assets: u64,
    deposit_amount: u64,
) -> Result<()> {
    let cap_config = find_cap_config(remaining_accounts, vault_key)?;

    if let Some(config) = cap_config {
        // Check global cap
        svs_caps::check_global_cap(total_assets, deposit_amount, config.global_cap).map_err(
            |e| match e {
                svs_caps::CapError::GlobalCapExceeded => VaultError::GlobalCapExceeded,
                svs_caps::CapError::MathOverflow => VaultError::MathOverflow,
                _ => VaultError::GlobalCapExceeded,
            },
        )?;

        // Check per-user cap if configured
        if config.per_user_cap > 0 {
            let user_deposit = find_user_deposit(remaining_accounts, vault_key, user_key)?;
            let user_cumulative = user_deposit.map(|ud| ud.cumulative_assets).unwrap_or(0);

            svs_caps::check_user_cap(user_cumulative, deposit_amount, config.per_user_cap)
                .map_err(|e| match e {
                    svs_caps::CapError::UserCapExceeded => VaultError::UserCapExceeded,
                    svs_caps::CapError::MathOverflow => VaultError::MathOverflow,
                    _ => VaultError::UserCapExceeded,
                })?;
        }
    }

    Ok(())
}

/// Apply entry fee to shares.
pub fn apply_entry_fee(
    remaining_accounts: &[AccountInfo],
    vault_key: &Pubkey,
    shares: u64,
) -> Result<DepositModuleResult> {
    let fee_config = find_fee_config(remaining_accounts, vault_key)?;

    if let Some(config) = fee_config {
        if config.entry_fee_bps > 0 {
            let (net_shares, fee_shares) = svs_fees::apply_entry_fee(shares, config.entry_fee_bps)
                .map_err(|_| VaultError::MathOverflow)?;

            return Ok(DepositModuleResult {
                net_shares,
                fee_shares,
                fee_recipient: Some(config.fee_recipient),
            });
        }
    }

    Ok(DepositModuleResult {
        net_shares: shares,
        fee_shares: 0,
        fee_recipient: None,
    })
}

/// Set share lock after deposit.
pub fn set_share_lock(
    remaining_accounts: &[AccountInfo],
    vault_key: &Pubkey,
    current_timestamp: i64,
) -> Result<i64> {
    let lock_config = find_lock_config(remaining_accounts, vault_key)?;

    if let Some(config) = lock_config {
        if config.lock_duration > 0 {
            let locked_until = svs_locks::set_lock(current_timestamp, config.lock_duration)
                .map_err(|_| VaultError::MathOverflow)?;
            return Ok(locked_until);
        }
    }

    Ok(0)
}

/// Check share lock before withdrawal.
pub fn check_share_lock(
    remaining_accounts: &[AccountInfo],
    vault_key: &Pubkey,
    owner_key: &Pubkey,
    current_timestamp: i64,
) -> Result<()> {
    let share_lock = find_share_lock(remaining_accounts, vault_key, owner_key)?;

    if let Some(lock) = share_lock {
        svs_locks::check_lockup(lock.locked_until, current_timestamp)
            .map_err(|_| VaultError::SharesLocked)?;
    }

    Ok(())
}

/// Result of pre-withdrawal module checks.
pub struct WithdrawModuleResult {
    /// Assets after exit fee deduction
    pub net_assets: u64,
    /// Exit fee assets (to transfer to fee recipient)
    pub fee_assets: u64,
    /// Fee recipient address (if fees enabled)
    pub fee_recipient: Option<Pubkey>,
}

/// Apply exit fee to assets.
pub fn apply_exit_fee(
    remaining_accounts: &[AccountInfo],
    vault_key: &Pubkey,
    assets: u64,
) -> Result<WithdrawModuleResult> {
    let fee_config = find_fee_config(remaining_accounts, vault_key)?;

    if let Some(config) = fee_config {
        if config.exit_fee_bps > 0 {
            let (net_assets, fee_assets) = svs_fees::apply_exit_fee(assets, config.exit_fee_bps)
                .map_err(|_| VaultError::MathOverflow)?;

            return Ok(WithdrawModuleResult {
                net_assets,
                fee_assets,
                fee_recipient: Some(config.fee_recipient),
            });
        }
    }

    Ok(WithdrawModuleResult {
        net_assets: assets,
        fee_assets: 0,
        fee_recipient: None,
    })
}

// =============================================================================
// PDA Finding Helpers
// =============================================================================

fn find_fee_config(
    remaining_accounts: &[AccountInfo],
    vault_key: &Pubkey,
) -> Result<Option<FeeConfig>> {
    let (expected_pda, _) =
        Pubkey::find_program_address(&[FEE_CONFIG_SEED, vault_key.as_ref()], &crate::ID);

    for account in remaining_accounts {
        if account.key() == expected_pda {
            let data = account.try_borrow_data()?;
            // Skip discriminator (8 bytes) and deserialize
            if data.len() >= FeeConfig::LEN {
                let config = FeeConfig::try_deserialize(&mut &data[8..])?;
                return Ok(Some(config));
            }
        }
    }

    Ok(None)
}

fn find_cap_config(
    remaining_accounts: &[AccountInfo],
    vault_key: &Pubkey,
) -> Result<Option<CapConfig>> {
    let (expected_pda, _) =
        Pubkey::find_program_address(&[CAP_CONFIG_SEED, vault_key.as_ref()], &crate::ID);

    for account in remaining_accounts {
        if account.key() == expected_pda {
            let data = account.try_borrow_data()?;
            if data.len() >= CapConfig::LEN {
                let config = CapConfig::try_deserialize(&mut &data[8..])?;
                return Ok(Some(config));
            }
        }
    }

    Ok(None)
}

fn find_user_deposit(
    remaining_accounts: &[AccountInfo],
    vault_key: &Pubkey,
    user_key: &Pubkey,
) -> Result<Option<UserDeposit>> {
    let (expected_pda, _) = Pubkey::find_program_address(
        &[USER_DEPOSIT_SEED, vault_key.as_ref(), user_key.as_ref()],
        &crate::ID,
    );

    for account in remaining_accounts {
        if account.key() == expected_pda {
            let data = account.try_borrow_data()?;
            if data.len() >= UserDeposit::LEN {
                let ud = UserDeposit::try_deserialize(&mut &data[8..])?;
                return Ok(Some(ud));
            }
        }
    }

    Ok(None)
}

fn find_lock_config(
    remaining_accounts: &[AccountInfo],
    vault_key: &Pubkey,
) -> Result<Option<LockConfig>> {
    let (expected_pda, _) =
        Pubkey::find_program_address(&[LOCK_CONFIG_SEED, vault_key.as_ref()], &crate::ID);

    for account in remaining_accounts {
        if account.key() == expected_pda {
            let data = account.try_borrow_data()?;
            if data.len() >= LockConfig::LEN {
                let config = LockConfig::try_deserialize(&mut &data[8..])?;
                return Ok(Some(config));
            }
        }
    }

    Ok(None)
}

fn find_share_lock(
    remaining_accounts: &[AccountInfo],
    vault_key: &Pubkey,
    owner_key: &Pubkey,
) -> Result<Option<ShareLock>> {
    let (expected_pda, _) = Pubkey::find_program_address(
        &[SHARE_LOCK_SEED, vault_key.as_ref(), owner_key.as_ref()],
        &crate::ID,
    );

    for account in remaining_accounts {
        if account.key() == expected_pda {
            let data = account.try_borrow_data()?;
            if data.len() >= ShareLock::LEN {
                let lock = ShareLock::try_deserialize(&mut &data[8..])?;
                return Ok(Some(lock));
            }
        }
    }

    Ok(None)
}

fn find_access_config(
    remaining_accounts: &[AccountInfo],
    vault_key: &Pubkey,
) -> Result<Option<AccessConfig>> {
    let (expected_pda, _) =
        Pubkey::find_program_address(&[ACCESS_CONFIG_SEED, vault_key.as_ref()], &crate::ID);

    for account in remaining_accounts {
        if account.key() == expected_pda {
            let data = account.try_borrow_data()?;
            if data.len() >= AccessConfig::LEN {
                let config = AccessConfig::try_deserialize(&mut &data[8..])?;
                return Ok(Some(config));
            }
        }
    }

    Ok(None)
}

fn find_frozen_account(
    remaining_accounts: &[AccountInfo],
    vault_key: &Pubkey,
    user_key: &Pubkey,
) -> Result<bool> {
    let (expected_pda, _) = Pubkey::find_program_address(
        &[b"frozen", vault_key.as_ref(), user_key.as_ref()],
        &crate::ID,
    );

    for account in remaining_accounts {
        if account.key() == expected_pda {
            // If account exists and has data, user is frozen
            let data = account.try_borrow_data()?;
            return Ok(data.len() > 8);
        }
    }

    Ok(false)
}
