use anchor_lang::prelude::*;

/// Per-pool wrapper config. Binds (cPOOL, dePOOL) mint pair and tracks
/// `locked_supply` to maintain `locked_supply == dePOOL.supply` at runtime.
///
/// Trust anchors (attestation program/issuer/type) are set at init and
/// immutable — rotating any requires re-deploying the wrapper for a new
/// pool. Prevents a "low-bar" attestation from satisfying a pool that
/// semantically requires a higher tier.
#[account]
pub struct WrapperConfig {
    pub pool: Pubkey,
    pub permissioned_mint: Pubkey,
    pub derwa_mint: Pubkey,
    /// Must equal `dePOOL.supply` at all times.
    pub locked_supply: u64,
    pub bump: u8,
    pub attestation_program: Pubkey,
    pub attestation_issuer: Pubkey,
    pub required_attestation_type: u8,
}

impl WrapperConfig {
    pub const SEED_PREFIX: &'static [u8] = b"wrapper_config";
    /// 8 + 32 + 32 + 32 + 8 + 1 + 32 + 32 + 1 = 178 bytes.
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 1 + 32 + 32 + 1;
}
