use anchor_lang::prelude::*;

/// Per-pool NAV account. PDA seeded by the SVS-11 CreditVault address.
///
/// Self-consistency invariant: `nav_net ≈ nav_gross × (1 − ter_bps/10000
/// − loss_provision_bps/10000)` within 1 bps tolerance.
#[account]
pub struct NavAccount {
    // ---- canonical SvsOraclePrice header (payload bytes 0..24) ----
    /// Net NAV == SvsOraclePrice.price (payload 0..8). Decimals match SVS-11
    /// `oracle_price_decimals`, default 9.
    pub nav_net: u64,
    /// == SvsOraclePrice.timestamp (payload 8..16).
    pub timestamp: i64,
    /// == SvsOraclePrice.sequence (payload 16..24). Strictly monotonic per pool.
    pub sequence: u64,
    // ---- implementation-specific (vault never reads) ----
    pub pool: Pubkey,
    pub nav_gross: u64,
    /// Total Expense Ratio in bps (e.g. 150 = 1.50%).
    pub ter_bps: u16,
    pub loss_provision_bps: u16,
    /// 0 = monthly audit close; 1 = event-driven impairment.
    pub nav_type: u8,
    /// Alignment padding — held to zero; excluded from signing_payload.
    pub _padding: [u8; 7],
    /// Authorized to call `update`. Rotation gated by the pool authority.
    pub publisher: Pubkey,
    /// Ed25519 over `signing_payload()`. Persisted for off-chain auditability.
    pub signature: [u8; 64],
    pub loan_tape_merkle_root: [u8; 32],
    /// Previous published nav_net, baseline for the consecutive-price
    /// deviation guard. 0 = genesis (no prior value; guard skipped).
    pub last_published_nav: u64,
    /// Max allowed consecutive-publish deviation, in basis points. Set at init.
    pub max_deviation_bps: u16,
}

impl NavAccount {
    pub const SEED_PREFIX: &'static [u8] = b"nav_oracle";
    pub const SPACE: usize = 8 + 8 + 8 + 8 + 32 + 8 + 2 + 2 + 1 + 7 + 32 + 64 + 32 + 8 + 2;

    /// Canonical 133-byte signing payload. Matches the TypeScript
    /// `buildSigningPayload` (sdk/core/src/nav-oracle.ts) byte-for-byte.
    /// Padding excluded.
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

#[cfg(test)]
mod layout_tests {
    use super::*;
    use anchor_lang::AnchorSerialize;

    /// NavAccount leads with the canonical `SvsOraclePrice` header so the
    /// generic `svs_oracle::read_oracle` parses it at one fixed window. In
    /// payload space (try_to_vec excludes the 8-byte discriminator): nav_net
    /// (price) 0..8, timestamp 8..16, sequence 16..24. On disk that is bytes
    /// 8..16 / 16..24 / 24..32 — matching `svs_oracle::PRICE_PAYLOAD_OFFSET`
    /// (8) + the 24-byte header. If this drifts, the vault reads garbage.
    #[test]
    fn nav_account_header_layout_stable_for_generic_reader() {
        let pool = Pubkey::new_unique();
        let publisher = Pubkey::new_unique();
        let nav = NavAccount {
            nav_net: 1_000_000_000,
            timestamp: 1_700_000_000,
            sequence: 42,
            pool,
            nav_gross: 1_010_000_000,
            ter_bps: 150,
            loss_provision_bps: 50,
            nav_type: 0,
            _padding: [0u8; 7],
            publisher,
            signature: [0u8; 64],
            loan_tape_merkle_root: [0u8; 32],
            last_published_nav: 0,
            max_deviation_bps: 500,
        };
        let bytes = nav.try_to_vec().expect("serialize");
        assert_eq!(
            bytes.len(),
            NavAccount::SPACE - 8,
            "NavAccount payload drifted from SPACE"
        );
        assert_eq!(
            u64::from_le_bytes(bytes[0..8].try_into().unwrap()),
            1_000_000_000,
            "nav_net (price) must lead the header at payload offset 0"
        );
        assert_eq!(
            i64::from_le_bytes(bytes[8..16].try_into().unwrap()),
            1_700_000_000,
            "timestamp must be at payload offset 8"
        );
        assert_eq!(
            u64::from_le_bytes(bytes[16..24].try_into().unwrap()),
            42,
            "sequence must be at payload offset 16"
        );
    }
}
