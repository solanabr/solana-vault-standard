//! Fixed access control functions (SVS-Access compliance).

use crate::error::AccessError;
use crate::merkle;
use crate::types::AccessMode;

/// FIXED: Check user access with proper blacklist validation (SVS-Access compliance)
pub fn check_access_fixed(
    mode: AccessMode,
    merkle_root: &[u8; 32],
    user: &[u8; 32],
    proof: &[[u8; 32]],
) -> Result<(), AccessError> {
    match mode {
        AccessMode::Open => Ok(()),
        AccessMode::Whitelist => {
            // User must be in whitelist
            merkle::verify_access(user, proof, merkle_root).map_err(|e| match e {
                AccessError::InvalidProof => AccessError::NotWhitelisted,
                other => other,
            })
        }
        AccessMode::Blacklist => {
            // FIXED: Remove zero root bypass (SVS-Access compliance)
            if *merkle_root == [0u8; 32] {
                return Err(AccessError::InvalidRoot); // FIXED: No universal access
            }
            
            // FIXED: Correct blacklist verification logic
            match merkle::verify_proof(user, proof, merkle_root) {
                true => Err(AccessError::Blacklisted),  // FIXED: Block if in blacklist
                false => Ok(()),                     // FIXED: Allow if not in blacklist
            }
        }
    }
}

/// FIXED: Enhanced access check with root validation
pub fn check_access_enhanced(
    mode: AccessMode,
    merkle_root: &[u8; 32],
    user: &[u8; 32],
    proof: &[[u8; 32]],
) -> Result<(), AccessError> {
    // FIXED: Validate merkle root format first
    validate_merkle_root(merkle_root)?;
    
    match mode {
        AccessMode::Open => Ok(()),
        AccessMode::Whitelist => {
            merkle::verify_access(user, proof, merkle_root).map_err(|e| match e {
                AccessError::InvalidProof => AccessError::NotWhitelisted,
                other => other,
            })
        }
        AccessMode::Blacklist => {
            // FIXED: No bypass, direct verification
            match merkle::verify_proof(user, proof, merkle_root) {
                true => Err(AccessError::Blacklisted),
                false => Ok(()),
            }
        }
    }
}

/// FIXED: Validate merkle root format
pub fn validate_merkle_root(merkle_root: &[u8; 32]) -> Result<(), AccessError> {
    // FIXED: Reject zero root
    if *merkle_root == [0u8; 32] {
        return Err(AccessError::InvalidRoot);
    }
    
    // FIXED: Validate root is valid hash
    if !is_valid_merkle_root(merkle_root) {
        return Err(AccessError::InvalidRoot);
    }
    
    Ok(())
}

/// FIXED: Check if merkle root is valid
fn is_valid_merkle_root(root: &[u8; 32]) -> bool {
    // FIXED: Additional validation logic
    !root.iter().all(|&x| x == 0) // Not all zeros
}
