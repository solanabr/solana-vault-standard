//! Module integration hooks for vault instructions.
//!
//! These functions search `remaining_accounts` for known module config PDAs
//! and apply the corresponding module logic. If a config PDA is not present,
//! the check is skipped (modules are opt-in).
//!
//! Each function accepts a `program_id` parameter for PDA derivation, allowing
//! all SVS vault programs to share this code.

use anchor_lang::prelude::*;

use crate::error::ModuleError;
use crate::state::{
    AccessMode, ACCESS_CONFIG_LEN, ACCESS_CONFIG_SEED, CAP_CONFIG_LEN, CAP_CONFIG_SEED,
    FEE_CONFIG_LEN, FEE_CONFIG_SEED, LOCK_CONFIG_LEN, LOCK_CONFIG_SEED, SHARE_LOCK_LEN,
    SHARE_LOCK_SEED, USER_DEPOSIT_LEN, USER_DEPOSIT_SEED,
};

// =============================================================================
// Internal deserialization structs (mirror program #[account] layouts)
// =============================================================================

#[derive(AnchorDeserialize)]
struct FeeConfigData {
    _vault: Pubkey,
    fee_recipient: Pubkey,
    entry_fee_bps: u16,
    exit_fee_bps: u16,
    _management_fee_bps: u16,
    _performance_fee_bps: u16,
    _high_water_mark: u64,
    _last_fee_collection: i64,
    _bump: u8,
}

#[derive(AnchorDeserialize)]
struct CapConfigData {
    _vault: Pubkey,
    global_cap: u64,
    per_user_cap: u64,
    _bump: u8,
}

#[derive(AnchorDeserialize)]
struct UserDepositData {
    _vault: Pubkey,
    _user: Pubkey,
    cumulative_assets: u64,
    _bump: u8,
}

#[derive(AnchorDeserialize)]
struct LockConfigData {
    _vault: Pubkey,
    lock_duration: i64,
    _bump: u8,
}

#[derive(AnchorDeserialize)]
struct ShareLockData {
    _vault: Pubkey,
    _owner: Pubkey,
    locked_until: i64,
    _bump: u8,
}

#[derive(AnchorDeserialize)]
struct AccessConfigData {
    _vault: Pubkey,
    mode: AccessMode,
    merkle_root: [u8; 32],
    _bump: u8,
}

// =============================================================================
// Public Result Types
// =============================================================================

/// Result of pre-deposit module checks.
pub struct DepositModuleResult {
    /// Shares after entry fee deduction
    pub net_shares: u64,
    /// Entry fee shares (to mint to fee recipient)
    pub fee_shares: u64,
    /// Fee recipient address (if fees enabled)
    pub fee_recipient: Option<Pubkey>,
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

// =============================================================================
// Hook Functions
// =============================================================================

/// Check access control for deposit.
pub fn check_deposit_access(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
    user_key: &Pubkey,
    merkle_proof: &[[u8; 32]],
) -> Result<()> {
    let access_config = find_access_config(remaining_accounts, program_id, vault_key)?;

    if let Some(config) = access_config {
        let mode = match config.mode {
            AccessMode::Open => svs_access::AccessMode::Open,
            AccessMode::Whitelist => svs_access::AccessMode::Whitelist,
            AccessMode::Blacklist => svs_access::AccessMode::Blacklist,
        };

        let user_bytes = user_key.to_bytes();
        svs_access::check_access(mode, &config.merkle_root, &user_bytes, merkle_proof).map_err(
            |e| match e {
                svs_access::AccessError::NotWhitelisted => {
                    error!(ModuleError::NotWhitelisted)
                }
                svs_access::AccessError::Blacklisted => {
                    error!(ModuleError::Blacklisted)
                }
                svs_access::AccessError::AccountFrozen => {
                    error!(ModuleError::AccountFrozen)
                }
                svs_access::AccessError::InvalidProof => {
                    error!(ModuleError::InvalidProof)
                }
                _ => error!(ModuleError::InvalidProof),
            },
        )?;

        // Check if user is frozen
        let frozen = find_frozen_account(remaining_accounts, program_id, vault_key, user_key)?;
        if frozen {
            return Err(error!(ModuleError::AccountFrozen));
        }
    }

    Ok(())
}

/// Check deposit caps.
pub fn check_deposit_caps(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
    user_key: &Pubkey,
    total_assets: u64,
    deposit_amount: u64,
) -> Result<()> {
    let cap_config = find_cap_config(remaining_accounts, program_id, vault_key)?;

    if let Some(config) = cap_config {
        svs_caps::check_global_cap(total_assets, deposit_amount, config.global_cap).map_err(
            |e| match e {
                svs_caps::CapError::GlobalCapExceeded => {
                    error!(ModuleError::GlobalCapExceeded)
                }
                svs_caps::CapError::MathOverflow => error!(ModuleError::MathOverflow),
                _ => error!(ModuleError::GlobalCapExceeded),
            },
        )?;

        if config.per_user_cap > 0 {
            let user_deposit =
                find_user_deposit(remaining_accounts, program_id, vault_key, user_key)?;
            let user_cumulative = user_deposit.map(|ud| ud.cumulative_assets).unwrap_or(0);

            svs_caps::check_user_cap(user_cumulative, deposit_amount, config.per_user_cap)
                .map_err(|e| match e {
                    svs_caps::CapError::UserCapExceeded => {
                        error!(ModuleError::UserCapExceeded)
                    }
                    svs_caps::CapError::MathOverflow => {
                        error!(ModuleError::MathOverflow)
                    }
                    _ => error!(ModuleError::UserCapExceeded),
                })?;
        }
    }

    Ok(())
}

/// Apply entry fee to shares.
pub fn apply_entry_fee(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
    shares: u64,
) -> Result<DepositModuleResult> {
    let fee_config = find_fee_config(remaining_accounts, program_id, vault_key)?;

    if let Some(config) = fee_config {
        if config.entry_fee_bps > 0 {
            let (net_shares, fee_shares) = svs_fees::apply_entry_fee(shares, config.entry_fee_bps)
                .map_err(|_| error!(ModuleError::MathOverflow))?;

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
    program_id: &Pubkey,
    vault_key: &Pubkey,
    current_timestamp: i64,
) -> Result<i64> {
    let lock_config = find_lock_config(remaining_accounts, program_id, vault_key)?;

    if let Some(config) = lock_config {
        if config.lock_duration > 0 {
            let locked_until = svs_locks::set_lock(current_timestamp, config.lock_duration)
                .map_err(|_| error!(ModuleError::MathOverflow))?;
            return Ok(locked_until);
        }
    }

    Ok(0)
}

/// Check share lock before withdrawal.
pub fn check_share_lock(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
    owner_key: &Pubkey,
    current_timestamp: i64,
) -> Result<()> {
    let share_lock = find_share_lock(remaining_accounts, program_id, vault_key, owner_key)?;

    if let Some(lock) = share_lock {
        svs_locks::check_lockup(lock.locked_until, current_timestamp)
            .map_err(|_| error!(ModuleError::SharesLocked))?;
    }

    Ok(())
}

/// Apply exit fee to assets.
pub fn apply_exit_fee(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
    assets: u64,
) -> Result<WithdrawModuleResult> {
    let fee_config = find_fee_config(remaining_accounts, program_id, vault_key)?;

    if let Some(config) = fee_config {
        if config.exit_fee_bps > 0 {
            let (net_assets, fee_assets) = svs_fees::apply_exit_fee(assets, config.exit_fee_bps)
                .map_err(|_| error!(ModuleError::MathOverflow))?;

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
    program_id: &Pubkey,
    vault_key: &Pubkey,
) -> Result<Option<FeeConfigData>> {
    let (expected_pda, _) =
        Pubkey::find_program_address(&[FEE_CONFIG_SEED, vault_key.as_ref()], program_id);

    for account in remaining_accounts {
        if account.key() == expected_pda {
            let data = account.try_borrow_data()?;
            if data.len() >= FEE_CONFIG_LEN {
                let config = AnchorDeserialize::deserialize(&mut &data[8..])?;
                return Ok(Some(config));
            }
        }
    }

    Ok(None)
}

fn find_cap_config(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
) -> Result<Option<CapConfigData>> {
    let (expected_pda, _) =
        Pubkey::find_program_address(&[CAP_CONFIG_SEED, vault_key.as_ref()], program_id);

    for account in remaining_accounts {
        if account.key() == expected_pda {
            let data = account.try_borrow_data()?;
            if data.len() >= CAP_CONFIG_LEN {
                let config = AnchorDeserialize::deserialize(&mut &data[8..])?;
                return Ok(Some(config));
            }
        }
    }

    Ok(None)
}

fn find_user_deposit(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
    user_key: &Pubkey,
) -> Result<Option<UserDepositData>> {
    let (expected_pda, _) = Pubkey::find_program_address(
        &[USER_DEPOSIT_SEED, vault_key.as_ref(), user_key.as_ref()],
        program_id,
    );

    for account in remaining_accounts {
        if account.key() == expected_pda {
            let data = account.try_borrow_data()?;
            if data.len() >= USER_DEPOSIT_LEN {
                let ud = AnchorDeserialize::deserialize(&mut &data[8..])?;
                return Ok(Some(ud));
            }
        }
    }

    Ok(None)
}

fn find_lock_config(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
) -> Result<Option<LockConfigData>> {
    let (expected_pda, _) =
        Pubkey::find_program_address(&[LOCK_CONFIG_SEED, vault_key.as_ref()], program_id);

    for account in remaining_accounts {
        if account.key() == expected_pda {
            let data = account.try_borrow_data()?;
            if data.len() >= LOCK_CONFIG_LEN {
                let config = AnchorDeserialize::deserialize(&mut &data[8..])?;
                return Ok(Some(config));
            }
        }
    }

    Ok(None)
}

fn find_share_lock(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
    owner_key: &Pubkey,
) -> Result<Option<ShareLockData>> {
    let (expected_pda, _) = Pubkey::find_program_address(
        &[SHARE_LOCK_SEED, vault_key.as_ref(), owner_key.as_ref()],
        program_id,
    );

    for account in remaining_accounts {
        if account.key() == expected_pda {
            let data = account.try_borrow_data()?;
            if data.len() >= SHARE_LOCK_LEN {
                let lock = AnchorDeserialize::deserialize(&mut &data[8..])?;
                return Ok(Some(lock));
            }
        }
    }

    Ok(None)
}

fn find_access_config(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
) -> Result<Option<AccessConfigData>> {
    let (expected_pda, _) =
        Pubkey::find_program_address(&[ACCESS_CONFIG_SEED, vault_key.as_ref()], program_id);

    for account in remaining_accounts {
        if account.key() == expected_pda {
            let data = account.try_borrow_data()?;
            if data.len() >= ACCESS_CONFIG_LEN {
                let config = AnchorDeserialize::deserialize(&mut &data[8..])?;
                return Ok(Some(config));
            }
        }
    }

    Ok(None)
}

fn find_frozen_account(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
    user_key: &Pubkey,
) -> Result<bool> {
    let (expected_pda, _) = Pubkey::find_program_address(
        &[b"frozen", vault_key.as_ref(), user_key.as_ref()],
        program_id,
    );

    for account in remaining_accounts {
        if account.key() == expected_pda {
            let data = account.try_borrow_data()?;
            return Ok(data.len() > 8);
        }
    }

    Ok(false)
}
