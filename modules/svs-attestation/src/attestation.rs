//! Canonical attestation parsing + verification.

use anchor_lang::prelude::{AccountInfo, Pubkey};

use crate::constants::*;
use crate::error::AttestationError;

/// Decoded attestation payload. Pubkeys are decoded eagerly; metadata fields
/// (`jurisdiction` / `investor_class` / `kyc_risk_tier`) are surfaced for
/// callers that enforce jurisdiction or investor-class policy (default-zero
/// means "no policy enforcement").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attestation {
    pub subject: Pubkey,
    pub issuer: Pubkey,
    pub attestation_type: u8,
    pub country_code: [u8; 2],
    pub issued_at: i64,
    pub expires_at: i64,
    pub revoked: bool,
    pub bump: u8,
    pub jurisdiction: [u8; 2],
    pub investor_class: u8,
    pub kyc_risk_tier: u8,
}

impl Attestation {
    /// Parse the canonical payload from raw account data, skipping the 8-byte
    /// Anchor discriminator. Returns [`AttestationError::Malformed`] if the
    /// account is shorter than [`ATTESTATION_ACCOUNT_LEN`].
    pub fn from_account_data(data: &[u8]) -> Result<Self, AttestationError> {
        if data.len() < ATTESTATION_ACCOUNT_LEN {
            return Err(AttestationError::Malformed);
        }
        let p = &data[DISCRIMINATOR_LEN..];

        let arr32 = |o: usize| -> Result<[u8; 32], AttestationError> {
            p[o..o + 32]
                .try_into()
                .map_err(|_| AttestationError::Malformed)
        };
        let arr8 = |o: usize| -> Result<[u8; 8], AttestationError> {
            p[o..o + 8]
                .try_into()
                .map_err(|_| AttestationError::Malformed)
        };
        let arr2 = |o: usize| -> Result<[u8; 2], AttestationError> {
            p[o..o + 2]
                .try_into()
                .map_err(|_| AttestationError::Malformed)
        };

        Ok(Self {
            subject: Pubkey::new_from_array(arr32(SUBJECT_OFFSET)?),
            issuer: Pubkey::new_from_array(arr32(ISSUER_OFFSET)?),
            attestation_type: p[ATTESTATION_TYPE_OFFSET],
            country_code: arr2(COUNTRY_CODE_OFFSET)?,
            issued_at: i64::from_le_bytes(arr8(ISSUED_AT_OFFSET)?),
            expires_at: i64::from_le_bytes(arr8(EXPIRES_AT_OFFSET)?),
            revoked: p[REVOKED_OFFSET] != 0,
            bump: p[BUMP_OFFSET],
            jurisdiction: arr2(JURISDICTION_OFFSET)?,
            investor_class: p[INVESTOR_CLASS_OFFSET],
            kyc_risk_tier: p[KYC_RISK_TIER_OFFSET],
        })
    }
}

/// Enforce the universal attestation invariants against the configured trust
/// anchors. Pure: it does not inspect account ownership or PDA derivation, so
/// it is independently unit-/property-testable. Owner + canonical-PDA binding
/// are added by [`verify_attestation`].
pub fn check_invariants(
    att: &Attestation,
    subject: &Pubkey,
    expected_issuer: &Pubkey,
    expected_type: u8,
    now: i64,
) -> Result<(), AttestationError> {
    if att.subject != *subject {
        return Err(AttestationError::SubjectMismatch);
    }
    if att.issuer != *expected_issuer {
        return Err(AttestationError::IssuerMismatch);
    }
    if att.attestation_type != expected_type {
        return Err(AttestationError::WrongType);
    }
    if att.revoked {
        return Err(AttestationError::Revoked);
    }
    // Valid iff expires_at is strictly in the future; a non-positive expiry
    // is therefore treated as expired.
    if att.expires_at <= now {
        return Err(AttestationError::Expired);
    }
    Ok(())
}

/// Full attestation verification: owner binding, layout parse, universal
/// invariants, and canonical-PDA binding. Returns the parsed [`Attestation`]
/// so callers can additionally read `jurisdiction` / `investor_class` /
/// `kyc_risk_tier`.
///
/// The canonical-PDA check atomically binds subject/issuer/type to the
/// physical account: a forged payload satisfying the field checks would
/// derive a different PDA and fail here.
///
/// # Arguments
/// * `att_info`            - the attestation account
/// * `attestation_program` - the only program permitted to own it
/// * `subject`             - the wallet the attestation must cover
/// * `expected_issuer`     - the configured attester (trust anchor)
/// * `expected_type`       - the required attestation type
/// * `now`                 - current unix timestamp
pub fn verify_attestation(
    att_info: &AccountInfo,
    attestation_program: &Pubkey,
    subject: &Pubkey,
    expected_issuer: &Pubkey,
    expected_type: u8,
    now: i64,
) -> Result<Attestation, AttestationError> {
    if att_info.owner != attestation_program {
        return Err(AttestationError::WrongOwner);
    }

    let data = att_info
        .try_borrow_data()
        .map_err(|_| AttestationError::Malformed)?;
    let att = Attestation::from_account_data(&data)?;

    check_invariants(&att, subject, expected_issuer, expected_type, now)?;

    let expected_pda = Pubkey::create_program_address(
        &[
            ATTESTATION_SEED_PREFIX,
            att.subject.as_ref(),
            att.issuer.as_ref(),
            &[att.attestation_type],
            &[att.bump],
        ],
        attestation_program,
    )
    .map_err(|_| AttestationError::InvalidPda)?;
    if *att_info.key != expected_pda {
        return Err(AttestationError::InvalidPda);
    }

    Ok(att)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a canonical 129-byte attestation account buffer.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn account_bytes(
        subject: Pubkey,
        issuer: Pubkey,
        attestation_type: u8,
        expires_at: i64,
        revoked: bool,
        bump: u8,
    ) -> Vec<u8> {
        let mut v = vec![0u8; ATTESTATION_ACCOUNT_LEN];
        let p = &mut v[DISCRIMINATOR_LEN..];
        p[SUBJECT_OFFSET..SUBJECT_OFFSET + 32].copy_from_slice(subject.as_ref());
        p[ISSUER_OFFSET..ISSUER_OFFSET + 32].copy_from_slice(issuer.as_ref());
        p[ATTESTATION_TYPE_OFFSET] = attestation_type;
        p[COUNTRY_CODE_OFFSET..COUNTRY_CODE_OFFSET + 2].copy_from_slice(b"BR");
        p[ISSUED_AT_OFFSET..ISSUED_AT_OFFSET + 8].copy_from_slice(&1_700_000_000i64.to_le_bytes());
        p[EXPIRES_AT_OFFSET..EXPIRES_AT_OFFSET + 8].copy_from_slice(&expires_at.to_le_bytes());
        p[REVOKED_OFFSET] = revoked as u8;
        p[BUMP_OFFSET] = bump;
        p[JURISDICTION_OFFSET..JURISDICTION_OFFSET + 2].copy_from_slice(b"CH");
        p[INVESTOR_CLASS_OFFSET] = 2;
        p[KYC_RISK_TIER_OFFSET] = 1;
        v
    }

    #[test]
    fn parses_canonical_layout() {
        let subject = Pubkey::new_unique();
        let issuer = Pubkey::new_unique();
        let data = account_bytes(subject, issuer, 7, 1_800_000_000, false, 254);
        let att = Attestation::from_account_data(&data).unwrap();
        assert_eq!(att.subject, subject);
        assert_eq!(att.issuer, issuer);
        assert_eq!(att.attestation_type, 7);
        assert_eq!(att.country_code, *b"BR");
        assert_eq!(att.issued_at, 1_700_000_000);
        assert_eq!(att.expires_at, 1_800_000_000);
        assert!(!att.revoked);
        assert_eq!(att.bump, 254);
        assert_eq!(att.jurisdiction, *b"CH");
        assert_eq!(att.investor_class, 2);
        assert_eq!(att.kyc_risk_tier, 1);
    }

    #[test]
    fn rejects_short_account() {
        assert_eq!(
            Attestation::from_account_data(&[0u8; ATTESTATION_ACCOUNT_LEN - 1]),
            Err(AttestationError::Malformed)
        );
    }

    /// Layout-stability guard: the cross-program offset readers depend on
    /// these exact positions. Mirrors the constant offsets so a silent drift
    /// (here or in `mock-sas`'s writer) is caught.
    #[test]
    fn layout_offsets_stable() {
        assert_eq!(SUBJECT_OFFSET, 0);
        assert_eq!(ISSUER_OFFSET, 32);
        assert_eq!(ATTESTATION_TYPE_OFFSET, 64);
        assert_eq!(EXPIRES_AT_OFFSET, 75);
        assert_eq!(REVOKED_OFFSET, 83);
        assert_eq!(BUMP_OFFSET, 84);
        assert_eq!(ATTESTATION_ACCOUNT_LEN, 129);
    }

    #[test]
    fn invariants_accept_valid() {
        let subject = Pubkey::new_unique();
        let issuer = Pubkey::new_unique();
        let att = Attestation::from_account_data(&account_bytes(
            subject,
            issuer,
            7,
            1_800_000_000,
            false,
            254,
        ))
        .unwrap();
        assert!(check_invariants(&att, &subject, &issuer, 7, 1_700_000_000).is_ok());
    }

    #[test]
    fn invariants_reject_each_mismatch() {
        let subject = Pubkey::new_unique();
        let issuer = Pubkey::new_unique();
        let att = Attestation::from_account_data(&account_bytes(
            subject,
            issuer,
            7,
            1_800_000_000,
            false,
            254,
        ))
        .unwrap();
        let now = 1_700_000_000;

        assert_eq!(
            check_invariants(&att, &Pubkey::new_unique(), &issuer, 7, now),
            Err(AttestationError::SubjectMismatch)
        );
        assert_eq!(
            check_invariants(&att, &subject, &Pubkey::new_unique(), 7, now),
            Err(AttestationError::IssuerMismatch)
        );
        assert_eq!(
            check_invariants(&att, &subject, &issuer, 9, now),
            Err(AttestationError::WrongType)
        );
        // Expired: now == expires_at is not strictly in the future.
        assert_eq!(
            check_invariants(&att, &subject, &issuer, 7, 1_800_000_000),
            Err(AttestationError::Expired)
        );
    }

    #[test]
    fn invariants_reject_revoked() {
        let subject = Pubkey::new_unique();
        let issuer = Pubkey::new_unique();
        let att = Attestation::from_account_data(&account_bytes(
            subject,
            issuer,
            7,
            1_800_000_000,
            true,
            254,
        ))
        .unwrap();
        assert_eq!(
            check_invariants(&att, &subject, &issuer, 7, 1_700_000_000),
            Err(AttestationError::Revoked)
        );
    }

    #[test]
    fn invariants_reject_nonpositive_expiry() {
        let subject = Pubkey::new_unique();
        let issuer = Pubkey::new_unique();
        let att = Attestation::from_account_data(&account_bytes(subject, issuer, 7, 0, false, 254))
            .unwrap();
        assert_eq!(
            check_invariants(&att, &subject, &issuer, 7, 1_700_000_000),
            Err(AttestationError::Expired)
        );
    }
}

#[cfg(test)]
mod proptests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        /// Any 32-byte subject/issuer round-trips through the offset parser.
        #[test]
        fn parse_roundtrip(
            subject_seed in any::<[u8; 32]>(),
            issuer_seed in any::<[u8; 32]>(),
            att_type in any::<u8>(),
            expires in any::<i64>(),
            revoked in any::<bool>(),
            bump in any::<u8>(),
        ) {
            let subject = Pubkey::new_from_array(subject_seed);
            let issuer = Pubkey::new_from_array(issuer_seed);
            let data = super::tests::account_bytes(subject, issuer, att_type, expires, revoked, bump);
            let att = Attestation::from_account_data(&data).unwrap();
            prop_assert_eq!(att.subject, subject);
            prop_assert_eq!(att.issuer, issuer);
            prop_assert_eq!(att.attestation_type, att_type);
            prop_assert_eq!(att.expires_at, expires);
            prop_assert_eq!(att.revoked, revoked);
            prop_assert_eq!(att.bump, bump);
        }

        /// Truncated buffers are always rejected, never parsed.
        #[test]
        fn truncated_always_rejected(len in 0usize..ATTESTATION_ACCOUNT_LEN) {
            prop_assert_eq!(
                Attestation::from_account_data(&vec![0u8; len]),
                Err(AttestationError::Malformed)
            );
        }
    }
}
