//! Core access control functions.

use crate::error::AccessError;
use crate::merkle;
use crate::types::AccessMode;

/// Check user access based on mode and merkle proof.
///
/// # Arguments
/// * `mode` - Access control mode (Open, Whitelist, Blacklist)
/// * `merkle_root` - Merkle root for whitelist/blacklist
/// * `user` - User's pubkey bytes
/// * `proof` - Merkle proof (empty if mode is Open)
///
/// # Returns
/// Ok(()) if access allowed, Err otherwise
///
/// # Example
/// ```
/// use svs_access::{check_access, AccessMode, merkle::hash_leaf};
///
/// // Open mode - always allowed
/// let user = [1u8; 32];
/// assert!(check_access(AccessMode::Open, &[0u8; 32], &user, &[]).is_ok());
///
/// // Whitelist mode - requires valid proof
/// let root = hash_leaf(&user);
/// assert!(check_access(AccessMode::Whitelist, &root, &user, &[]).is_ok());
/// ```
pub fn check_access(
    mode: AccessMode,
    merkle_root: &[u8; 32],
    user: &[u8; 32],
    proof: &[[u8; 32]],
) -> Result<(), AccessError> {
    match mode {
        AccessMode::Open => Ok(()),
        AccessMode::Whitelist => {
            // User must be in the whitelist
            merkle::verify_access(user, proof, merkle_root).map_err(|e| match e {
                AccessError::InvalidProof => AccessError::NotWhitelisted,
                other => other,
            })
        }
        AccessMode::Blacklist => {
            // If root is not set, no one is blacklisted
            if *merkle_root == [0u8; 32] {
                return Ok(());
            }

            // User must NOT be in the blacklist
            match merkle::verify_proof(user, proof, merkle_root) {
                true => Err(AccessError::Blacklisted),
                false => Ok(()),
            }
        }
    }
}

/// Check if account is frozen.
///
/// # Arguments
/// * `is_frozen` - Whether the frozen account PDA exists
///
/// # Returns
/// Ok(()) if not frozen, Err(AccountFrozen) if frozen
pub fn check_not_frozen(is_frozen: bool) -> Result<(), AccessError> {
    if is_frozen {
        Err(AccessError::AccountFrozen)
    } else {
        Ok(())
    }
}

/// Combined access check including freeze status.
///
/// # Arguments
/// * `mode` - Access control mode
/// * `merkle_root` - Merkle root for whitelist/blacklist
/// * `user` - User's pubkey bytes
/// * `proof` - Merkle proof
/// * `is_frozen` - Whether user is frozen
///
/// # Returns
/// Ok(()) if access allowed and not frozen
pub fn verify_full_access(
    mode: AccessMode,
    merkle_root: &[u8; 32],
    user: &[u8; 32],
    proof: &[[u8; 32]],
    is_frozen: bool,
) -> Result<(), AccessError> {
    // Check freeze first
    check_not_frozen(is_frozen)?;

    // Then check access mode
    check_access(mode, merkle_root, user, proof)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merkle::hash_leaf;

    #[test]
    fn test_check_access_open() {
        let user = [1u8; 32];
        assert!(check_access(AccessMode::Open, &[0u8; 32], &user, &[]).is_ok());
    }

    #[test]
    fn test_check_access_whitelist() {
        let user = [1u8; 32];
        let root = hash_leaf(&user);

        // Valid proof
        assert!(check_access(AccessMode::Whitelist, &root, &user, &[]).is_ok());

        // Invalid proof
        let other_user = [2u8; 32];
        assert_eq!(
            check_access(AccessMode::Whitelist, &root, &other_user, &[]),
            Err(AccessError::NotWhitelisted)
        );
    }

    #[test]
    fn test_check_access_blacklist() {
        let blocked_user = [1u8; 32];
        let root = hash_leaf(&blocked_user);

        // Blacklisted user with valid proof -> blocked
        assert_eq!(
            check_access(AccessMode::Blacklist, &root, &blocked_user, &[]),
            Err(AccessError::Blacklisted)
        );

        // Non-blacklisted user with invalid proof -> allowed
        let good_user = [2u8; 32];
        assert!(check_access(AccessMode::Blacklist, &root, &good_user, &[]).is_ok());
    }

    #[test]
    fn test_check_access_blacklist_empty_root() {
        let user = [1u8; 32];
        // Empty root = no blacklist = everyone allowed
        assert!(check_access(AccessMode::Blacklist, &[0u8; 32], &user, &[]).is_ok());
    }

    #[test]
    fn test_check_not_frozen() {
        assert!(check_not_frozen(false).is_ok());
        assert_eq!(check_not_frozen(true), Err(AccessError::AccountFrozen));
    }

    #[test]
    fn test_verify_full_access() {
        let user = [1u8; 32];

        // Open mode, not frozen
        assert!(verify_full_access(AccessMode::Open, &[0u8; 32], &user, &[], false).is_ok());

        // Open mode, frozen -> blocked
        assert_eq!(
            verify_full_access(AccessMode::Open, &[0u8; 32], &user, &[], true),
            Err(AccessError::AccountFrozen)
        );

        // Whitelist, valid proof, not frozen
        let root = hash_leaf(&user);
        assert!(verify_full_access(AccessMode::Whitelist, &root, &user, &[], false).is_ok());

        // Whitelist, valid proof, frozen -> blocked
        assert_eq!(
            verify_full_access(AccessMode::Whitelist, &root, &user, &[], true),
            Err(AccessError::AccountFrozen)
        );
    }
}
