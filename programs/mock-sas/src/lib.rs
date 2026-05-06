use anchor_lang::prelude::*;

declare_id!("GTTMWDHTZibyEpqNRr33RnBhgms262U6qHaGrjoHqEXg");

#[program]
pub mod mock_sas {
    use super::*;

    pub fn create_attestation(
        ctx: Context<CreateAttestation>,
        issuer: Pubkey,
        attestation_type: u8,
        country_code: [u8; 2],
        expires_at: i64,
    ) -> Result<()> {
        // Backward-compatible wrapper. New metadata fields default to zero
        // ("no policy enforcement" / infrastructure tier).
        create_attestation_inner(
            ctx, issuer, attestation_type, country_code, expires_at, None, None, None,
        )
    }

    /// Create an attestation with metadata fields (jurisdiction,
    /// investor_class, kyc_risk_tier). Each is optional and defaults
    /// to zero (= "no policy enforcement"); pass `Some(...)` to set
    /// explicit values. Mirrors the layout the ComplianceHook reads
    /// in Permissioned mode.
    pub fn create_attestation_with_metadata(
        ctx: Context<CreateAttestation>,
        issuer: Pubkey,
        attestation_type: u8,
        country_code: [u8; 2],
        expires_at: i64,
        jurisdiction: Option<[u8; 2]>,
        investor_class: Option<u8>,
        kyc_risk_tier: Option<u8>,
    ) -> Result<()> {
        create_attestation_inner(
            ctx,
            issuer,
            attestation_type,
            country_code,
            expires_at,
            jurisdiction,
            investor_class,
            kyc_risk_tier,
        )
    }

    pub fn revoke_attestation(ctx: Context<RevokeAttestation>) -> Result<()> {
        let account_info = ctx.accounts.attestation.to_account_info();
        let mut data = account_info.try_borrow_mut_data()?;
        // revoked field is at offset: 8 (disc) + 32 (subject) + 32 (issuer) + 1 (type) + 2 (country) + 8 (issued_at) + 8 (expires_at) = 91
        data[91] = 1; // true
        Ok(())
    }
}

fn create_attestation_inner(
    ctx: Context<CreateAttestation>,
    issuer: Pubkey,
    attestation_type: u8,
    country_code: [u8; 2],
    expires_at: i64,
    jurisdiction: Option<[u8; 2]>,
    investor_class: Option<u8>,
    kyc_risk_tier: Option<u8>,
) -> Result<()> {
    let account_info = ctx.accounts.attestation.to_account_info();
    let mut data = account_info.try_borrow_mut_data()?;
    let clock = Clock::get()?;

    let mut offset = 0;

    // 8-byte Anchor discriminator (zeroed for mock)
    data[offset..offset + 8].copy_from_slice(&[0u8; 8]);
    offset += 8;

    // subject (32)
    data[offset..offset + 32].copy_from_slice(&ctx.accounts.subject.key().to_bytes());
    offset += 32;

    // issuer (32)
    data[offset..offset + 32].copy_from_slice(&issuer.to_bytes());
    offset += 32;

    // attestation_type (1)
    data[offset] = attestation_type;
    offset += 1;

    // country_code (2)
    data[offset..offset + 2].copy_from_slice(&country_code);
    offset += 2;

    // issued_at (8)
    data[offset..offset + 8].copy_from_slice(&clock.unix_timestamp.to_le_bytes());
    offset += 8;

    // expires_at (8)
    data[offset..offset + 8].copy_from_slice(&expires_at.to_le_bytes());
    offset += 8;

    // revoked (1)
    data[offset] = 0; // false
    offset += 1;

    // bump (1)
    data[offset] = ctx.bumps.attestation;
    offset += 1;

    // _reserved (32)
    data[offset..offset + 32].copy_from_slice(&[0u8; 32]);
    offset += 32;

    // ↓ Metadata extension (4 bytes total). Default-zero values mean
    // "no policy enforcement" / infrastructure tier; the ComplianceHook
    // treats zeros as wildcards.
    // jurisdiction (2)
    data[offset..offset + 2].copy_from_slice(&jurisdiction.unwrap_or([0u8; 2]));
    offset += 2;

    // investor_class (1)
    data[offset] = investor_class.unwrap_or(0);
    offset += 1;

    // kyc_risk_tier (1)
    data[offset] = kyc_risk_tier.unwrap_or(0);

    Ok(())
}

// Account size: 8 (disc) + 32 + 32 + 1 + 2 + 8 + 8 + 1 + 1 + 32 + 2 + 1 + 1 = 129
// Layout includes the metadata extension (jurisdiction, investor_class,
// kyc_risk_tier) appended after _reserved.
const ATTESTATION_ACCOUNT_SIZE: usize = 129;

#[derive(Accounts)]
#[instruction(issuer: Pubkey, attestation_type: u8)]
pub struct CreateAttestation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Raw account written with spec Attestation layout
    #[account(
        init,
        payer = authority,
        space = ATTESTATION_ACCOUNT_SIZE,
        seeds = [b"attestation", subject.key().as_ref(), issuer.as_ref(), &[attestation_type]],
        bump,
    )]
    pub attestation: UncheckedAccount<'info>,

    /// CHECK: Subject identity for PDA derivation
    pub subject: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeAttestation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Raw attestation account — revoked flag set directly
    #[account(mut)]
    pub attestation: UncheckedAccount<'info>,
}
