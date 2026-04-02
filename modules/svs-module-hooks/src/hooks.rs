//! Module integration hooks for vault instructions.
//!
//! These functions search `remaining_accounts` for known module config PDAs
//! and apply the corresponding module logic. If a config PDA is not present,
//! the check is skipped (modules are opt-in).
//!
//! Each function accepts a `program_id` parameter for PDA derivation, allowing
//! all SVS vault programs to share this code.
//!
//! # V5-M2: Frozen account PDA requirement
//!
//! **Vault programs MUST pass the frozen account PDA** (seeds: `[b"frozen",
//! vault_key, user_key]`) in `remaining_accounts` for both deposit and
//! withdrawal hooks. If the PDA is omitted, the freeze check cannot detect
//! frozen users. The `find_frozen_account` helper derives the expected PDA
//! and scans `remaining_accounts` for a match.

use anchor_lang::prelude::*;

use crate::error::ModuleError;
use crate::state::{
    AccessMode, ACCESS_CONFIG_LEN, ACCESS_CONFIG_SEED, CAP_CONFIG_LEN, CAP_CONFIG_SEED,
    FEE_CONFIG_LEN, FEE_CONFIG_SEED, FROZEN_ACCOUNT_LEN, LOCK_CONFIG_LEN, LOCK_CONFIG_SEED,
    SHARE_LOCK_LEN, SHARE_LOCK_SEED, USER_DEPOSIT_LEN, USER_DEPOSIT_SEED,
};

// =============================================================================
// V5-M3: Anchor account discriminators (sha256("account:<Name>")[0..8])
// V6-M3: These are verified at compile time via const assertions below.
//   Source struct names: FeeConfig, CapConfig, UserDeposit, LockConfig,
//   ShareLock, AccessConfig, FrozenAccount
// =============================================================================

const DISC_FEE_CONFIG: [u8; 8] = [0x8f, 0x34, 0x92, 0xbb, 0xdb, 0x7b, 0x4c, 0x9b];
const DISC_CAP_CONFIG: [u8; 8] = [0x65, 0x7e, 0xec, 0xc2, 0xab, 0x0b, 0xfa, 0x0b];
const DISC_USER_DEPOSIT: [u8; 8] = [0x45, 0xee, 0x17, 0xd9, 0xff, 0x89, 0xb9, 0x23];
const DISC_LOCK_CONFIG: [u8; 8] = [0x6a, 0x2f, 0xee, 0x9f, 0x7c, 0x0c, 0xa0, 0xc0];
const DISC_SHARE_LOCK: [u8; 8] = [0x6f, 0xf7, 0xf3, 0x5e, 0x04, 0xee, 0xce, 0x93];
const DISC_ACCESS_CONFIG: [u8; 8] = [0xf5, 0x91, 0xe8, 0x20, 0x4d, 0x54, 0x2e, 0x53];
const DISC_FROZEN_ACCOUNT: [u8; 8] = [0x9e, 0xe4, 0x22, 0xbc, 0x1c, 0x53, 0xe4, 0xf4];

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

#[derive(AnchorDeserialize, AnchorSerialize)]
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

/// Check access control (whitelist/blacklist + freeze).
pub fn check_access(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
    user_key: &Pubkey,
    merkle_proof: &[[u8; 32]],
) -> Result<()> {
    check_deposit_access(
        remaining_accounts,
        program_id,
        vault_key,
        user_key,
        merkle_proof,
    )
}

/// Check access control for deposit (best-effort freeze check).
///
/// If the frozen PDA is not passed in `remaining_accounts`, the user is
/// assumed not frozen. For strict freeze enforcement, use
/// `check_deposit_access_strict`.
///
/// V9-P16: Programs using this best-effort variant (SVS-9, SVS-10, SVS-12) allow
/// clients to omit the frozen PDA to bypass the freeze check. SVS-11 uses its own
/// dedicated frozen_check PDA account field and is not affected. For vaults requiring
/// mandatory freeze enforcement, switch to `check_deposit_access_strict`.
pub fn check_deposit_access(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
    user_key: &Pubkey,
    merkle_proof: &[[u8; 32]],
) -> Result<()> {
    check_deposit_access_inner(
        remaining_accounts,
        program_id,
        vault_key,
        user_key,
        merkle_proof,
        false,
    )
}

/// Check access control for deposit (strict freeze check).
///
/// V5-M2: The frozen PDA account (seeds: `[b"frozen", vault_key, user_key]`)
/// MUST be present in `remaining_accounts`. If omitted, the instruction fails
/// with `FrozenCheckRequired`. Use this for high-security vaults where freeze
/// bypass via omitted accounts is unacceptable.
///
/// # Fundamental Limitation
///
/// On-chain programs cannot detect whether a PDA exists if the client does not
/// pass the account. This strict variant mitigates the issue by requiring the
/// frozen PDA to always be passed. If the PDA doesn't exist on-chain (wrong
/// owner / system-owned), the user is considered not frozen. If the PDA exists
/// and is a valid FrozenAccount, the user is frozen.
pub fn check_deposit_access_strict(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
    user_key: &Pubkey,
    merkle_proof: &[[u8; 32]],
) -> Result<()> {
    check_deposit_access_inner(
        remaining_accounts,
        program_id,
        vault_key,
        user_key,
        merkle_proof,
        true,
    )
}

fn check_deposit_access_inner(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
    user_key: &Pubkey,
    merkle_proof: &[[u8; 32]],
    require_frozen_check: bool,
) -> Result<()> {
    // Check if user is frozen — must run unconditionally, even for Open-mode
    // vaults that have no AccessConfig. A frozen user must not interact with
    // any vault regardless of access mode.
    check_frozen_status(
        remaining_accounts,
        program_id,
        vault_key,
        user_key,
        require_frozen_check,
    )?;

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
    }

    Ok(())
}

/// Check access control for withdrawal/redemption paths (best-effort freeze).
///
/// V5-M1: Checks freeze status to prevent frozen users from withdrawing.
/// Vault programs MUST call this on every withdrawal/redemption.
///
/// If the frozen PDA is not in `remaining_accounts`, the user is assumed not
/// frozen. For strict enforcement, use `check_withdrawal_access_strict`.
pub fn check_withdrawal_access(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
    user_key: &Pubkey,
) -> Result<()> {
    check_frozen_status(remaining_accounts, program_id, vault_key, user_key, false)?;
    Ok(())
}

/// Check access control for withdrawal/redemption paths (strict freeze).
///
/// V5-M2: The frozen PDA MUST be present in `remaining_accounts`. See
/// `check_deposit_access_strict` for details on the strict mode behavior.
pub fn check_withdrawal_access_strict(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
    user_key: &Pubkey,
) -> Result<()> {
    check_frozen_status(remaining_accounts, program_id, vault_key, user_key, true)?;
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

/// Update cumulative deposit tracking for per-user caps.
///
/// Finds the UserDeposit PDA in remaining_accounts and increments
/// `cumulative_assets` by `deposit_amount`. Silently skips if the
/// UserDeposit account is not present (caps module not configured).
pub fn update_user_deposit(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
    user_key: &Pubkey,
    deposit_amount: u64,
) -> Result<()> {
    let (expected_pda, _) = Pubkey::find_program_address(
        &[USER_DEPOSIT_SEED, vault_key.as_ref(), user_key.as_ref()],
        program_id,
    );

    for account in remaining_accounts {
        if account.key() == expected_pda {
            // V5-M6: If account exists at the PDA address but has wrong owner,
            // this indicates corruption — not a missing optional module.
            if account.owner != program_id {
                return Err(error!(ModuleError::InvalidAccountOwner));
            }
            let mut data = account.try_borrow_mut_data()?;
            if data.len() >= USER_DEPOSIT_LEN {
                // V5-M3: Validate discriminator before deserialization
                validate_discriminator(&data, &DISC_USER_DEPOSIT)?;
                // V4-M9: Deserialize via AnchorDeserialize instead of hardcoded byte
                // offsets to avoid silent breakage if UserDepositData fields change.
                let mut reader: &[u8] = &data[8..]; // skip discriminator
                let mut ud: UserDepositData = AnchorDeserialize::deserialize(&mut reader)
                    .map_err(|_| error!(ModuleError::MathOverflow))?;
                let updated = ud
                    .cumulative_assets
                    .checked_add(deposit_amount)
                    .ok_or_else(|| error!(ModuleError::MathOverflow))?;
                ud.cumulative_assets = updated;

                // Serialize back after discriminator
                let mut writer = &mut data[8..];
                AnchorSerialize::serialize(&ud, &mut writer)
                    .map_err(|_| error!(ModuleError::MathOverflow))?;
            }
            return Ok(());
        }
    }

    // UserDeposit not in remaining_accounts — caps module not active, skip
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
// Discriminator Validation Helper
// =============================================================================

/// V5-M3: Validate account discriminator before deserialization.
fn validate_discriminator(data: &[u8], expected: &[u8; 8]) -> Result<()> {
    if data.len() < 8 {
        return Err(error!(ModuleError::InvalidDiscriminator));
    }
    if data[0..8] != expected[..] {
        return Err(error!(ModuleError::InvalidDiscriminator));
    }
    Ok(())
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
            if account.owner != program_id {
                // V6-M2: Log when PDA exists with wrong owner — distinguishes
                // "module not configured" from "module account corrupted/closed"
                msg!(
                    "WARN: fee config PDA exists but wrong owner (expected {}, got {})",
                    program_id,
                    account.owner
                );
                return Ok(None);
            }
            let data = account.try_borrow_data()?;
            if data.len() >= FEE_CONFIG_LEN {
                validate_discriminator(&data, &DISC_FEE_CONFIG)?;
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
            if account.owner != program_id {
                // V6-M2: Log wrong-owner PDA
                msg!("WARN: cap config PDA exists but wrong owner");
                return Ok(None);
            }
            let data = account.try_borrow_data()?;
            if data.len() >= CAP_CONFIG_LEN {
                validate_discriminator(&data, &DISC_CAP_CONFIG)?;
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
            if account.owner != program_id {
                // V6-M2: Log wrong-owner PDA
                msg!("WARN: user deposit PDA exists but wrong owner");
                return Ok(None);
            }
            let data = account.try_borrow_data()?;
            if data.len() >= USER_DEPOSIT_LEN {
                validate_discriminator(&data, &DISC_USER_DEPOSIT)?;
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
            if account.owner != program_id {
                // V6-M2: Log wrong-owner PDA
                msg!("WARN: lock config PDA exists but wrong owner");
                return Ok(None);
            }
            let data = account.try_borrow_data()?;
            if data.len() >= LOCK_CONFIG_LEN {
                validate_discriminator(&data, &DISC_LOCK_CONFIG)?;
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
            if account.owner != program_id {
                // V6-M2: Log wrong-owner PDA
                msg!("WARN: share lock PDA exists but wrong owner");
                return Ok(None);
            }
            let data = account.try_borrow_data()?;
            if data.len() >= SHARE_LOCK_LEN {
                validate_discriminator(&data, &DISC_SHARE_LOCK)?;
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
            if account.owner != program_id {
                // V6-M2: Log wrong-owner PDA
                msg!("WARN: access config PDA exists but wrong owner");
                return Ok(None);
            }
            let data = account.try_borrow_data()?;
            if data.len() >= ACCESS_CONFIG_LEN {
                validate_discriminator(&data, &DISC_ACCESS_CONFIG)?;
                let config = AnchorDeserialize::deserialize(&mut &data[8..])?;
                return Ok(Some(config));
            }
        }
    }

    Ok(None)
}

/// V5-M2: Check frozen status with optional strict mode.
///
/// Derives the frozen PDA and scans `remaining_accounts`:
/// - If found with correct owner and discriminator: user IS frozen -> error.
/// - If found but wrong owner or uninitialized: user is NOT frozen -> ok.
/// - If NOT found in remaining_accounts:
///   - `require_frozen_check = true`: error (PDA must be passed).
///   - `require_frozen_check = false`: assume not frozen (backwards-compatible).
///
/// # Fundamental Limitation
///
/// An on-chain program cannot detect whether a PDA exists if the client omits
/// the account entirely. When `require_frozen_check` is false, a malicious
/// client can bypass the freeze check by not passing the frozen PDA. Vault
/// programs that need strict freeze enforcement SHOULD set this to true.
fn check_frozen_status(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    vault_key: &Pubkey,
    user_key: &Pubkey,
    require_frozen_check: bool,
) -> Result<()> {
    let (expected_pda, _) = Pubkey::find_program_address(
        &[b"frozen", vault_key.as_ref(), user_key.as_ref()],
        program_id,
    );

    // Scan remaining_accounts for the derived frozen PDA
    let mut pda_found = false;
    for account in remaining_accounts {
        if account.key() == expected_pda {
            pda_found = true;

            // Account exists at the PDA address — check if it's a valid
            // FrozenAccount owned by the program
            if account.owner != program_id {
                // Wrong owner: account is uninitialized or owned by system
                // program. User is not frozen.
                break;
            }

            let data = account.try_borrow_data()?;
            if data.len() < FROZEN_ACCOUNT_LEN {
                // Too short to be a valid FrozenAccount — not frozen
                break;
            }

            validate_discriminator(&data, &DISC_FROZEN_ACCOUNT)?;

            // Valid FrozenAccount found — user is frozen
            return Err(error!(ModuleError::AccountFrozen));
        }
    }

    // Frozen PDA was not found in remaining_accounts
    if !pda_found && require_frozen_check {
        return Err(error!(ModuleError::FrozenCheckRequired));
    }

    Ok(())
}

// =============================================================================
// V6-M3: Compile-time discriminator verification
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::hash::hash;

    fn anchor_discriminator(name: &str) -> [u8; 8] {
        let input = format!("account:{}", name);
        let h = hash(input.as_bytes());
        let mut disc = [0u8; 8];
        disc.copy_from_slice(&h.to_bytes()[..8]);
        disc
    }

    #[test]
    fn verify_hardcoded_discriminators() {
        assert_eq!(
            DISC_FEE_CONFIG,
            anchor_discriminator("FeeConfig"),
            "FeeConfig discriminator mismatch"
        );
        assert_eq!(
            DISC_CAP_CONFIG,
            anchor_discriminator("CapConfig"),
            "CapConfig discriminator mismatch"
        );
        assert_eq!(
            DISC_USER_DEPOSIT,
            anchor_discriminator("UserDeposit"),
            "UserDeposit discriminator mismatch"
        );
        assert_eq!(
            DISC_LOCK_CONFIG,
            anchor_discriminator("LockConfig"),
            "LockConfig discriminator mismatch"
        );
        assert_eq!(
            DISC_SHARE_LOCK,
            anchor_discriminator("ShareLock"),
            "ShareLock discriminator mismatch"
        );
        assert_eq!(
            DISC_ACCESS_CONFIG,
            anchor_discriminator("AccessConfig"),
            "AccessConfig discriminator mismatch"
        );
        assert_eq!(
            DISC_FROZEN_ACCOUNT,
            anchor_discriminator("FrozenAccount"),
            "FrozenAccount discriminator mismatch"
        );
    }
}
