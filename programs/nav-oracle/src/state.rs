use anchor_lang::prelude::*;

/// Per-pool NAV account. One PDA per pool, seeded by pool_id (the SVS-11 pool's
/// CreditVault PDA address).
///
/// Self-consistency invariant (verifiable on-chain):
///   nav_net ≈ nav_gross × (1 − ter_bps/10000 − loss_provision_bps/10000)
///
/// Within a 1-bps tolerance for integer-rounding effects.
#[account]
pub struct NavAccount {
    /// Pool this NAV is for (matches SVS-11 CreditVault PDA address).
    pub pool: Pubkey,

    /// Net NAV in pool's denomination (raw u64; what SVS-11 uses for share pricing).
    /// Decimals match `oracle_price_decimals` from SVS-11 SOLANA_CONFIG (default 9).
    pub nav_net: u64,

    /// Gross NAV before fees + loss provision.
    pub nav_gross: u64,

    /// Total Expense Ratio in basis points (e.g. 150 = 1.50%).
    pub ter_bps: u16,

    /// Expected-loss provision in basis points.
    pub loss_provision_bps: u16,

    /// 0 = monthly official close (audit-authoritative)
    /// 1 = event-driven impairment (off-cycle reaction to material event)
    pub nav_type: u8,

    /// Padding for alignment.
    pub _padding: [u8; 7],

    /// Unix-timestamp seconds when this NAV was computed by the publisher.
    pub timestamp: i64,

    /// Monotonically increasing per pool. SVS-11 read rejects stale sequences.
    pub sequence: u64,

    /// The publisher key authorized to call `update`. Rotation goes through
    /// `rotate_publisher` (gated by `key_rotation_authority`).
    pub publisher: Pubkey,

    /// Ed25519 signature over the canonical byte serialization of the
    /// preceding fields (pool..publisher), as defined in the publisher protocol.
    pub signature: [u8; 64],

    /// Merkle root of `[hash(receivable_row) for row in tape_snapshot]`.
    /// Auditors can request individual rows + merkle proof from the backend.
    pub loan_tape_merkle_root: [u8; 32],

    /// Authority that controls publisher rotations (typically a
    /// governance or multisig authority).
    pub key_rotation_authority: Pubkey,
}

impl NavAccount {
    pub const SEED_PREFIX: &'static [u8] = b"nav_oracle";

    /// Account size budget:
    /// 8 (discriminator) + 32 (pool) + 8 (nav_net) + 8 (nav_gross) +
    /// 2 (ter_bps) + 2 (loss_provision) + 1 (nav_type) + 7 (padding) +
    /// 8 (timestamp) + 8 (sequence) + 32 (publisher) + 64 (signature) +
    /// 32 (merkle_root) + 32 (key_rotation_authority)
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 2 + 2 + 1 + 7 + 8 + 8 + 32 + 64 + 32 + 32;

    /// Returns the canonical byte sequence the publisher signed.
    /// Reused on-chain for `ed25519_verify` and off-chain by the publisher.
    /// Length: 32 (pool) + 8 + 8 + 2 + 2 + 1 + 8 + 8 + 32 (publisher) + 32 (merkle_root) = 133 bytes.
    /// Padding bytes are intentionally excluded — matches Python `build_signing_payload`.
    pub fn signing_payload(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(133);
        buf.extend_from_slice(self.pool.as_ref());
        buf.extend_from_slice(&self.nav_net.to_le_bytes());
        buf.extend_from_slice(&self.nav_gross.to_le_bytes());
        buf.extend_from_slice(&self.ter_bps.to_le_bytes());
        buf.extend_from_slice(&self.loss_provision_bps.to_le_bytes());
        buf.push(self.nav_type);
        buf.extend_from_slice(&self.timestamp.to_le_bytes());
        buf.extend_from_slice(&self.sequence.to_le_bytes());
        buf.extend_from_slice(self.publisher.as_ref());
        buf.extend_from_slice(&self.loan_tape_merkle_root);
        buf
    }

    /// Verify nav_net ≈ nav_gross × (1 − ter − loss) within 1bps tolerance.
    pub fn verify_self_consistency(&self) -> bool {
        let factor_bps = 10_000_i64
            .checked_sub(self.ter_bps as i64).unwrap_or(0)
            .checked_sub(self.loss_provision_bps as i64).unwrap_or(0);
        if factor_bps <= 0 { return false; }
        // expected = nav_gross * factor_bps / 10000
        let expected = (self.nav_gross as u128)
            .checked_mul(factor_bps as u128).unwrap_or(0)
            .checked_div(10_000).unwrap_or(0);
        let nav_net_u128 = self.nav_net as u128;
        // Tolerance: 1 bps of nav_gross
        let tolerance = (self.nav_gross as u128) / 10_000;
        nav_net_u128.abs_diff(expected) <= tolerance
    }
}
