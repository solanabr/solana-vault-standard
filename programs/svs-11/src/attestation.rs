use anchor_lang::prelude::*;

use crate::error::VaultError;
use crate::state::CreditVault;

/// External attestation account layout (owned by any attestation program).
/// Matches the spec's generic interface — compatible with SAS, Civic Pass, or
/// any provider that writes accounts in this format.
///
/// Field-order invariant: existing field offsets MUST NOT shift. New
/// metadata fields are appended after `_reserved` (additive-only).
/// ComplianceHook's `check_attestation` helper and the deRWA wrapper's
/// `unwrap` instruction read these fields by absolute byte offset;
/// reordering or inserting in the middle silently breaks them.
///
/// Byte offsets (after the 8-byte Anchor discriminator):
///   0..32    subject (Pubkey)
///   32..64   issuer (Pubkey)
///   64       attestation_type (u8)
///   65..67   country_code ([u8; 2])
///   67..75   issued_at (i64)
///   75..83   expires_at (i64)
///   83       revoked (bool)
///   84       bump (u8)
///   85..117  _reserved ([u8; 32])
///   117..119 jurisdiction ([u8; 2])  -- added with the ComplianceHook metadata extension
///   119      investor_class (u8)     -- added with the ComplianceHook metadata extension
///   120      kyc_risk_tier (u8)      -- added with the ComplianceHook metadata extension
#[derive(AnchorDeserialize)]
pub struct Attestation {
    pub subject: Pubkey,
    pub issuer: Pubkey,
    pub attestation_type: u8,
    pub country_code: [u8; 2],
    pub issued_at: i64,
    pub expires_at: i64,
    pub revoked: bool,
    pub bump: u8,
    pub _reserved: [u8; 32],
    // ↓ NEW FIELDS APPENDED — order is load-bearing for the
    // ComplianceHook + deRWA wrapper offset readers. Default-zero values
    // mean "no policy enforcement" (infrastructure tier / unset
    // jurisdiction / unset risk tier), preserving backward compatibility
    // for accounts created before this upgrade (those accounts get
    // realloc'd in the bundled deploy).
    /// ISO 3166-1 alpha-2 jurisdiction code (e.g. b"BR", b"CH"). [0, 0] = unset.
    pub jurisdiction: [u8; 2],
    /// Investor classification: 0=infrastructure, 1=retail, 2=accredited, 3=qualified.
    pub investor_class: u8,
    /// KYC risk tier: 0=unset, 1=low, 2=medium, 3=high.
    pub kyc_risk_tier: u8,
}

impl Attestation {
    // Original layout (117 bytes): 8 disc + 32 + 32 + 1 + 2 + 8 + 8 + 1 + 1 + 32
    // ComplianceHook metadata extension (+4 bytes): 2 jurisdiction + 1 investor_class + 1 kyc_risk_tier
    pub const LEN: usize = 8 + 32 + 32 + 1 + 2 + 8 + 8 + 1 + 1 + 32 + 2 + 1 + 1;
}

pub fn validate_attestation(
    attestation_info: &AccountInfo,
    vault: &CreditVault,
    investor: &Pubkey,
    clock: &Clock,
) -> Result<()> {
    require!(
        attestation_info.owner == &vault.attestation_program,
        VaultError::InvalidAttestationProgram
    );

    let data = attestation_info.try_borrow_data()?;
    // Skip 8-byte Anchor discriminator
    require!(data.len() >= 8, VaultError::InvalidAttestation);
    let attestation = Attestation::try_from_slice(&data[8..])
        .map_err(|_| error!(VaultError::InvalidAttestation))?;

    require!(
        attestation.subject == *investor,
        VaultError::InvalidAttestation
    );

    require!(
        attestation.issuer == vault.attester,
        VaultError::InvalidAttester
    );

    require!(!attestation.revoked, VaultError::AttestationRevoked);

    require!(attestation.expires_at > 0, VaultError::InvalidAttestation);
    require!(
        attestation.expires_at > clock.unix_timestamp,
        VaultError::AttestationExpired
    );

    // Enforce attestation_type matches vault's required type. Prevents a low-bar
    // attestation (e.g. generic KYC) from satisfying a vault that semantically
    // requires a different type when the attester issues multiple types.
    require!(
        attestation.attestation_type == vault.required_attestation_type,
        VaultError::InvalidAttestation
    );

    // Verify the attestation account is a canonical PDA derived under the
    // attestation program. Seed convention: [b"attestation", subject, issuer, attestation_type].
    let expected_pda = Pubkey::create_program_address(
        &[
            b"attestation",
            investor.as_ref(),
            attestation.issuer.as_ref(),
            &[attestation.attestation_type],
            &[attestation.bump],
        ],
        &vault.attestation_program,
    )
    .map_err(|_| error!(VaultError::InvalidAttestation))?;
    require!(
        attestation_info.key() == expected_pda,
        VaultError::InvalidAttestation
    );

    Ok(())
}
