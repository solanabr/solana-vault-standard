//! Merkle tree utilities for access control.

use crate::error::AccessError;

/// Hash a leaf node (user pubkey).
///
/// Uses blake3 for fast, secure hashing.
pub fn hash_leaf(user: &[u8; 32]) -> [u8; 32] {
    // Prefix with 0x00 to distinguish leaf from internal nodes
    let mut data = [0u8; 33];
    data[0] = 0x00;
    data[1..33].copy_from_slice(user);
    *blake3::hash(&data).as_bytes()
}

/// Hash two child nodes to create parent.
fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    // Prefix with 0x01 to distinguish internal node from leaf
    let mut data = [0u8; 65];
    data[0] = 0x01;

    // Sort children for consistent ordering
    if left <= right {
        data[1..33].copy_from_slice(left);
        data[33..65].copy_from_slice(right);
    } else {
        data[1..33].copy_from_slice(right);
        data[33..65].copy_from_slice(left);
    }

    *blake3::hash(&data).as_bytes()
}

/// Verify a merkle proof for a user.
///
/// # Arguments
/// * `user` - User's pubkey bytes
/// * `proof` - Array of sibling hashes from leaf to root
/// * `root` - Expected merkle root
///
/// # Returns
/// true if proof is valid, false otherwise
///
/// # Example
/// ```
/// use svs_access::merkle::{verify_proof, hash_leaf, compute_root};
///
/// // Single user - root is the leaf hash
/// let user = [1u8; 32];
/// let root = hash_leaf(&user);
/// assert!(verify_proof(&user, &[], &root));
/// ```
pub fn verify_proof(user: &[u8; 32], proof: &[[u8; 32]], root: &[u8; 32]) -> bool {
    let mut current = hash_leaf(user);

    for sibling in proof {
        current = hash_pair(&current, sibling);
    }

    current == *root
}

/// Compute merkle root from a list of users.
///
/// # Arguments
/// * `users` - Slice of user pubkey bytes (must not be empty)
///
/// # Returns
/// Merkle root hash
pub fn compute_root(users: &[[u8; 32]]) -> [u8; 32] {
    if users.is_empty() {
        return [0u8; 32];
    }

    // Hash all leaves
    let mut hashes: Vec<[u8; 32]> = users.iter().map(hash_leaf).collect();

    // Build tree bottom-up
    while hashes.len() > 1 {
        let mut next_level = Vec::with_capacity((hashes.len() + 1) / 2);

        for i in (0..hashes.len()).step_by(2) {
            if i + 1 < hashes.len() {
                next_level.push(hash_pair(&hashes[i], &hashes[i + 1]));
            } else {
                // Odd number of nodes - promote the last one
                next_level.push(hashes[i]);
            }
        }

        hashes = next_level;
    }

    hashes[0]
}

/// Generate merkle proof for a specific user.
///
/// # Arguments
/// * `users` - All users in the tree
/// * `user_index` - Index of the user to generate proof for
///
/// # Returns
/// Proof as vector of sibling hashes
pub fn generate_proof(users: &[[u8; 32]], user_index: usize) -> Vec<[u8; 32]> {
    if users.is_empty() || user_index >= users.len() {
        return vec![];
    }

    if users.len() == 1 {
        return vec![];
    }

    // Hash all leaves
    let mut hashes: Vec<[u8; 32]> = users.iter().map(hash_leaf).collect();
    let mut proof = Vec::new();
    let mut index = user_index;

    // Build tree and collect proof
    while hashes.len() > 1 {
        // Get sibling
        let sibling_index = if index % 2 == 0 { index + 1 } else { index - 1 };
        if sibling_index < hashes.len() {
            proof.push(hashes[sibling_index]);
        }

        // Build next level
        let mut next_level = Vec::with_capacity((hashes.len() + 1) / 2);
        for i in (0..hashes.len()).step_by(2) {
            if i + 1 < hashes.len() {
                next_level.push(hash_pair(&hashes[i], &hashes[i + 1]));
            } else {
                next_level.push(hashes[i]);
            }
        }

        hashes = next_level;
        index /= 2;
    }

    proof
}

/// Verify access using merkle proof.
///
/// # Arguments
/// * `user` - User's pubkey bytes
/// * `proof` - Merkle proof
/// * `root` - Expected merkle root
///
/// # Returns
/// Ok(()) if proof is valid
pub fn verify_access(
    user: &[u8; 32],
    proof: &[[u8; 32]],
    root: &[u8; 32],
) -> Result<(), AccessError> {
    // Empty root means no list is configured
    if *root == [0u8; 32] {
        return Err(AccessError::MerkleRootNotSet);
    }

    if verify_proof(user, proof, root) {
        Ok(())
    } else {
        Err(AccessError::InvalidProof)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_user() {
        let user = [1u8; 32];
        let root = hash_leaf(&user);
        assert!(verify_proof(&user, &[], &root));
    }

    #[test]
    fn test_two_users() {
        let user1 = [1u8; 32];
        let user2 = [2u8; 32];

        let root = compute_root(&[user1, user2]);
        let proof1 = generate_proof(&[user1, user2], 0);
        let proof2 = generate_proof(&[user1, user2], 1);

        assert!(verify_proof(&user1, &proof1, &root));
        assert!(verify_proof(&user2, &proof2, &root));

        // Wrong user should fail
        let wrong_user = [3u8; 32];
        assert!(!verify_proof(&wrong_user, &proof1, &root));
    }

    #[test]
    fn test_four_users() {
        let users = [[1u8; 32], [2u8; 32], [3u8; 32], [4u8; 32]];

        let root = compute_root(&users);

        for (i, user) in users.iter().enumerate() {
            let proof = generate_proof(&users, i);
            assert!(verify_proof(user, &proof, &root), "Failed for user {}", i);
        }
    }

    #[test]
    fn test_odd_number_of_users() {
        let users = [[1u8; 32], [2u8; 32], [3u8; 32]];

        let root = compute_root(&users);

        for (i, user) in users.iter().enumerate() {
            let proof = generate_proof(&users, i);
            assert!(verify_proof(user, &proof, &root), "Failed for user {}", i);
        }
    }

    #[test]
    fn test_verify_access() {
        let user = [1u8; 32];
        let root = hash_leaf(&user);

        assert!(verify_access(&user, &[], &root).is_ok());
    }

    #[test]
    fn test_verify_access_empty_root() {
        let user = [1u8; 32];
        let root = [0u8; 32];

        assert_eq!(
            verify_access(&user, &[], &root),
            Err(AccessError::MerkleRootNotSet)
        );
    }

    #[test]
    fn test_verify_access_invalid_proof() {
        let user = [1u8; 32];
        let other_user = [2u8; 32];
        let root = hash_leaf(&other_user);

        assert_eq!(
            verify_access(&user, &[], &root),
            Err(AccessError::InvalidProof)
        );
    }
}
