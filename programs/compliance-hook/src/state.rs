use anchor_lang::prelude::*;

/// Global sanctions list (one per program deployment).
/// Authority is held by the deployment's configured governance authority.
///
/// Address space: capped at 256 sanctioned wallets at init. Realloc
/// extends capacity in 256-entry chunks if needed (future concern). The
/// 256 cap keeps `SPACE` under Solana's 10_240-byte CPI allocation
/// limit (`MAX_PERMITTED_DATA_INCREASE`) so `init` succeeds in one CPI.
#[account]
pub struct SanctionsList {
    /// Governance authority controlling updates.
    pub authority: Pubkey,

    /// Increments on every successful update; consumers can detect changes.
    pub version: u64,

    /// Unix-timestamp seconds; set by program at update time.
    pub updated_at: i64,

    /// Sanctioned addresses. Bounded by `MAX_ADDRESSES` (init capacity).
    pub addresses: Vec<Pubkey>,
}

impl SanctionsList {
    pub const MAX_ADDRESSES: usize = 256;
    pub const SEED_PREFIX: &'static [u8] = b"sanctions_list";

    /// Account size budget for `init` allocation:
    /// 8 (discriminator) + 32 (authority) + 8 (version) + 8 (updated_at)
    /// plus 4 (Vec length prefix) + 32 * MAX_ADDRESSES (data) =
    /// 60 + 8192 = 8252 bytes (under the 10_240 CPI realloc cap).
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 4 + (32 * Self::MAX_ADDRESSES);

    pub fn contains(&self, addr: &Pubkey) -> bool {
        self.addresses.contains(addr)
    }
}

/// Mode discriminator stored at mint-config-PDA level.
///
/// `FreelyTransferable` — sanctions + frozen checks only; transfers
/// proceed without an attestation. Used for dePOOL-style freely
/// transferable mints.
///
/// `Permissioned` — full SVS-11 attestation enforcement on both source
/// and destination ATA owners. The `execute` handler reads
/// `MintConfig.attestation_program / attestation_issuer /
/// required_attestation_type` to validate the attestation accounts
/// passed by the Token-2022 runtime.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ComplianceMode {
    FreelyTransferable,
    Permissioned,
}

/// Mint config PDA — bound to a specific Token-2022 mint that uses this hook.
///
/// Seeds: `[b"mint_config", mint_pubkey]`
///
/// Layout (post-discriminator):
/// - `mint`                       : `Pubkey` (32 bytes)              offset   8..40
/// - `mode`                       : `ComplianceMode` (1 byte)         offset  40..41
/// - `pool_policy`                : `Option<Pubkey>` (1 + up to 32)   offset  41..74
/// - `attestation_program`        : `Pubkey` (32 bytes)               offset  74..106
/// - `attestation_issuer`         : `Pubkey` (32 bytes)               offset 106..138
/// - `required_attestation_type`  : `u8` (1 byte)                     offset 138..139
///
/// `pool_policy` reserves the 33-byte max-case so layout is fixed-size;
/// the `Option<Pubkey>` byte at offset 41 is the discriminator
/// (0 = None, 1 = Some). The ExtraAccountMetaList builder reads the
/// configured `pool_policy` value and stores it as a fixed pubkey extra
/// in Permissioned mode.
///
/// Trust-anchor fields (`attestation_program`, `attestation_issuer`,
/// `required_attestation_type`) are appended AFTER pool_policy to
/// preserve the existing offset reads in the EAML builder. Field-order
/// is load-bearing — see `initialize_extra_account_meta_list.rs` for
/// the exact byte offsets it depends on.
#[account]
pub struct MintConfig {
    pub mint: Pubkey,
    pub mode: ComplianceMode,
    /// Optional pool policy PDA (Permissioned mode); unused in FreelyTransferable.
    pub pool_policy: Option<Pubkey>,
    /// Program that owns acceptable attestation accounts. Validated by
    /// `execute::check_attestation` against the passed attestation
    /// accounts' `owner`. `Pubkey::default()` is reserved for "unset"
    /// and is rejected at init when `mode == Permissioned`.
    pub attestation_program: Pubkey,
    /// Expected `issuer` field on attestation payloads. Pins the trust
    /// anchor for this mint to a specific compliance attester. Same
    /// semantics as `WrapperConfig.attestation_issuer` in derwa-wrapper.
    pub attestation_issuer: Pubkey,
    /// Required `attestation_type` byte. Encodes the KYC tier (e.g.
    /// 0 = generic KYC, 2 = accredited investor) — prevents a low-tier
    /// attestation from satisfying a Permissioned mint that requires a
    /// higher tier when the same issuer issues multiple types.
    pub required_attestation_type: u8,
}

impl MintConfig {
    pub const SEED_PREFIX: &'static [u8] = b"mint_config";
    /// Account size: 139 bytes. 8 (discriminator), 32 (mint), 1 (mode), 1
    /// (Option tag), 32 (Pubkey), 32 (attestation_program), 32
    /// (attestation_issuer), 1 (required_attestation_type). Max-case
    /// `Option<Pubkey>` reserves all 33 fixed bytes.
    pub const SPACE: usize = 8 + 32 + 1 + 1 + 32 + 32 + 32 + 1;
}

/// Per-wallet freeze marker. Existence at `[b"frozen", owner]` indicates
/// that the wallet is frozen across ALL hook-bound mints; `execute` reads
/// `lamports() > 0 && data_len() > 0` and rejects with `AccountFrozen`.
///
/// Authority: created and closed by `freeze_account` / `unfreeze_account`,
/// gated by `SanctionsList.authority` (typically a governance or multisig
/// authority). This is intentionally a coarser policy than per-vault freezes
/// (e.g. SVS-11's `[b"frozen_account", vault, investor]`) — compliance-hook
/// is a generic Token-2022 transfer hook and a single freeze authority
/// is easier to manage across mints.
///
/// The struct itself carries only `bump` so the account has a non-empty,
/// well-formed body; the freeze CHECK in `execute` is purely existence-
/// based, but a typed account makes `unfreeze_account`'s `close = recipient`
/// constraint clean.
#[account]
pub struct FrozenAccount {
    pub bump: u8,
}

impl FrozenAccount {
    pub const SEED_PREFIX: &'static [u8] = b"frozen";
    /// 8 (discriminator) + 1 (bump) = 9 bytes.
    pub const SPACE: usize = 8 + 1;
}
