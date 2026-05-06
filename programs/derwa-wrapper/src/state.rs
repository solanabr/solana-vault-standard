use anchor_lang::prelude::*;

/// Per-pool wrapper config. One PDA per pool, seeded by the pool's CreditVault PDA.
///
/// Binds together the cPOOL (Permissioned) mint and the dePOOL (FreelyTransferable)
/// mint for a single pool, and tracks the cPOOL locked inside the wrapper PDA so
/// the 1:1 invariant (`locked_supply == dePOOL.supply`) can be checked on-chain.
///
/// Trust-anchor fields (`attestation_program`, `attestation_issuer`,
/// `required_attestation_type`) capture the per-pool KYB/KYC posture: an
/// attestation is only accepted by `unwrap` if it is owned by the configured
/// program, signed by the configured issuer, and matches the required type.
/// These fields are set at `initialize` time and are immutable thereafter —
/// rotating any of them would require re-deploying the wrapper for a new
/// pool. This avoids a class of attack where a "low-bar" attestation
/// (generic KYC) satisfies a vault that semantically requires a different
/// attestation type (e.g. accredited-investor).
#[account]
pub struct WrapperConfig {
    /// Pool this wrapper is for.
    pub pool: Pubkey,

    /// Token-2022 mint for permissioned cPOOL (compliance hook in Permissioned mode).
    pub permissioned_mint: Pubkey,

    /// Token-2022 mint for freely-transferable dePOOL (compliance hook in FreelyTransferable mode).
    pub derwa_mint: Pubkey,

    /// Total cPOOL currently locked in the wrapper PDA. Increments on wrap, decrements on unwrap.
    /// Must equal total dePOOL supply at all times (1:1 invariant).
    pub locked_supply: u64,

    pub bump: u8,

    /// Program that owns acceptable attestation accounts (e.g. mock-sas /
    /// real SAS / Civic Pass). `unwrap` enforces
    /// `attestation_account.owner == attestation_program`, which is the
    /// first defense against a forged attestation account in a foreign
    /// program. Pubkey::default() is reserved for "unset" and is rejected
    /// at init for safety.
    pub attestation_program: Pubkey,

    /// Expected `issuer` field on the attestation payload. The `unwrap`
    /// handler reads `payload[32..64]` and requires it equals this value.
    /// This binds the pool to a specific KYB attester — a Cayman LLC pool
    /// gated by a single Brazilian compliance issuer can't be unwrapped
    /// using an attestation from a different jurisdiction's issuer, even
    /// if both issuers use the same attestation program.
    pub attestation_issuer: Pubkey,

    /// Required `attestation_type` byte. The `unwrap` handler reads
    /// `payload[64]` and requires it equals this value. Prevents a
    /// low-tier attestation (e.g. type 0 = generic KYC) from satisfying a
    /// vault that semantically requires a higher tier (e.g. type 2 =
    /// accredited investor) when the same issuer issues multiple types.
    pub required_attestation_type: u8,
}

impl WrapperConfig {
    pub const SEED_PREFIX: &'static [u8] = b"wrapper_config";

    /// Account size budget for `init` allocation:
    /// 8 (discriminator) + 32 (pool) + 32 (permissioned_mint) + 32 (derwa_mint)
    /// + 8 (locked_supply) + 1 (bump) + 32 (attestation_program)
    /// + 32 (attestation_issuer) + 1 (required_attestation_type)
    /// = 178 bytes.
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 1 + 32 + 32 + 1;
}
