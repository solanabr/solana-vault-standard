use anchor_lang::prelude::*;

/// Global sanctions list (one per program deployment). 256-entry init
/// cap keeps `SPACE` under Solana's 10_240-byte CPI realloc limit; larger
/// lists require chunked realloc (deferred).
#[account]
pub struct SanctionsList {
    pub authority: Pubkey,
    pub version: u64,
    pub updated_at: i64,
    pub addresses: Vec<Pubkey>,
}

impl SanctionsList {
    pub const MAX_ADDRESSES: usize = 256;
    pub const SEED_PREFIX: &'static [u8] = b"sanctions_list";
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 4 + (32 * Self::MAX_ADDRESSES);

    pub fn contains(&self, addr: &Pubkey) -> bool {
        self.addresses.contains(addr)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ComplianceMode {
    /// Sanctions + frozen checks only; transfers proceed without attestation.
    FreelyTransferable,
    /// Full SVS-11 attestation enforcement on source + destination ATA owners.
    Permissioned,
}

/// Per-mint config PDA: `[b"mint_config", mint]`.
///
/// Field order is load-bearing — the `ExtraAccountMetaList` builder reads
/// `attestation_issuer` at byte 106 and `required_attestation_type` at
/// byte 138 of this struct (post-discriminator). `pool_policy: Option<Pubkey>`
/// occupies 33 bytes when Some (its required state in Permissioned mode);
/// see `initialize_extra_account_meta_list.rs` for the offset map.
#[account]
pub struct MintConfig {
    pub mint: Pubkey,
    pub mode: ComplianceMode,
    pub pool_policy: Option<Pubkey>,
    pub attestation_program: Pubkey,
    pub attestation_issuer: Pubkey,
    pub required_attestation_type: u8,
}

impl MintConfig {
    pub const SEED_PREFIX: &'static [u8] = b"mint_config";
    /// 8 + 32 + 1 + (1+32) + 32 + 32 + 1 = 139 bytes (Option<Pubkey> = 33 max).
    pub const SPACE: usize = 8 + 32 + 1 + 1 + 32 + 32 + 32 + 1;
}

/// Per-wallet freeze marker at `[b"frozen", owner]`. Existence = frozen
/// across all hook-bound mints. Created/closed by freeze/unfreeze ixs
/// gated by `SanctionsList.authority`.
#[account]
pub struct FrozenAccount {
    pub bump: u8,
}

impl FrozenAccount {
    pub const SEED_PREFIX: &'static [u8] = b"frozen";
    pub const SPACE: usize = 8 + 1;
}

#[cfg(test)]
mod layout_tests {
    use super::*;
    use anchor_lang::AnchorSerialize;

    /// EAML's `Seed::AccountData` reads at offsets 106 (attestation_issuer)
    /// and 138 (required_attestation_type) assume `MintConfig` with
    /// `pool_policy = Some(_)` serializes to exactly 131 bytes (139 SPACE
    /// minus the 8-byte Anchor discriminator). If Borsh ever changes how
    /// `Option<Pubkey>::Some` encodes, or if MintConfig fields are
    /// reordered, this test fires before the EAML reads silently break.
    #[test]
    fn mint_config_permissioned_layout_stable() {
        let cfg = MintConfig {
            mint: Pubkey::new_unique(),
            mode: ComplianceMode::Permissioned,
            pool_policy: Some(Pubkey::new_unique()),
            attestation_program: Pubkey::new_unique(),
            attestation_issuer: Pubkey::new_unique(),
            required_attestation_type: 7,
        };
        let bytes = cfg.try_to_vec().expect("serialize");
        assert_eq!(
            bytes.len(),
            MintConfig::SPACE - 8,
            "MintConfig payload size drifted — EAML byte offsets (106, 138) are no longer valid"
        );

        // Verify the load-bearing offsets directly.
        // After payload start: 32 (mint) + 1 (mode) + 1 (Some tag) + 32 (pool_policy)
        //                    + 32 (attestation_program) = 98 → attestation_issuer at 98..130
        // With 8-byte discriminator on disk: 8 + 98 = 106. ✓
        let attestation_issuer_offset_in_payload = 32 + 1 + 1 + 32 + 32;
        assert_eq!(
            attestation_issuer_offset_in_payload, 98,
            "EAML reads attestation_issuer at on-disk offset 106 (= 98 + 8 disc)"
        );
        assert_eq!(
            &bytes[attestation_issuer_offset_in_payload..attestation_issuer_offset_in_payload + 32],
            cfg.attestation_issuer.as_ref(),
        );
        // required_attestation_type at on-disk offset 138 = payload offset 130.
        assert_eq!(bytes[130], 7);
    }
}
