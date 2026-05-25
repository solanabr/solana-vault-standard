use anchor_lang::prelude::*;

/// Per-pool NAV account. PDA seeded by the SVS-11 CreditVault address.
///
/// Self-consistency invariant: `nav_net ≈ nav_gross × (1 − ter_bps/10000
/// − loss_provision_bps/10000)` within 1 bps tolerance.
#[account]
pub struct NavAccount {
    pub pool: Pubkey,
    /// Net NAV (decimals match SVS-11 `oracle_price_decimals`, default 9).
    pub nav_net: u64,
    pub nav_gross: u64,
    /// Total Expense Ratio in bps (e.g. 150 = 1.50%).
    pub ter_bps: u16,
    pub loss_provision_bps: u16,
    /// 0 = monthly audit close; 1 = event-driven impairment.
    pub nav_type: u8,
    /// Alignment padding — held to zero; excluded from signing_payload.
    pub _padding: [u8; 7],
    pub timestamp: i64,
    /// Strictly monotonic per pool; SVS-11 reject_redeem rejects stale reads.
    pub sequence: u64,
    /// Authorized to call `update`. Rotation gated by `key_rotation_authority`.
    pub publisher: Pubkey,
    /// Ed25519 over `signing_payload()`. Persisted for off-chain auditability.
    pub signature: [u8; 64],
    pub loan_tape_merkle_root: [u8; 32],
    pub key_rotation_authority: Pubkey,
}

impl NavAccount {
    pub const SEED_PREFIX: &'static [u8] = b"nav_oracle";
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 2 + 2 + 1 + 7 + 8 + 8 + 32 + 64 + 32 + 32;

    /// Canonical 133-byte signing payload. Matches Python publisher
    /// `build_signing_payload` byte-for-byte. Padding excluded.
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

    pub fn verify_self_consistency(&self) -> bool {
        let ter_i64: i64 = self.ter_bps.into();
        let loss_i64: i64 = self.loss_provision_bps.into();
        let factor_bps = 10_000_i64
            .checked_sub(ter_i64)
            .unwrap_or(0)
            .checked_sub(loss_i64)
            .unwrap_or(0);
        if factor_bps <= 0 {
            return false;
        }
        let nav_gross_u128: u128 = self.nav_gross.into();
        let factor_u128: u128 = u128::try_from(factor_bps).unwrap_or(0);
        let expected = nav_gross_u128
            .checked_mul(factor_u128)
            .unwrap_or(0)
            .checked_div(10_000)
            .unwrap_or(0);
        let nav_net_u128: u128 = self.nav_net.into();
        let tolerance = nav_gross_u128 / 10_000;
        nav_net_u128.abs_diff(expected) <= tolerance
    }
}
