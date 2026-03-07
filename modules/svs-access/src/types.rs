//! Access control types.

/// Access control mode for the vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum AccessMode {
    /// Open access - anyone can interact with the vault.
    Open = 0,
    /// Whitelist - only users with valid merkle proofs can interact.
    Whitelist = 1,
    /// Blacklist - anyone except users with valid merkle proofs can interact.
    Blacklist = 2,
}

impl AccessMode {
    /// Convert from u8 representation.
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(AccessMode::Open),
            1 => Some(AccessMode::Whitelist),
            2 => Some(AccessMode::Blacklist),
            _ => None,
        }
    }

    /// Check if merkle proof is required.
    pub fn requires_proof(&self) -> bool {
        matches!(self, AccessMode::Whitelist | AccessMode::Blacklist)
    }
}

impl Default for AccessMode {
    fn default() -> Self {
        AccessMode::Open
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_access_mode_from_u8() {
        assert_eq!(AccessMode::from_u8(0), Some(AccessMode::Open));
        assert_eq!(AccessMode::from_u8(1), Some(AccessMode::Whitelist));
        assert_eq!(AccessMode::from_u8(2), Some(AccessMode::Blacklist));
        assert_eq!(AccessMode::from_u8(3), None);
    }

    #[test]
    fn test_requires_proof() {
        assert!(!AccessMode::Open.requires_proof());
        assert!(AccessMode::Whitelist.requires_proof());
        assert!(AccessMode::Blacklist.requires_proof());
    }
}
