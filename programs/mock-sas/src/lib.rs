use anchor_lang::prelude::*;

declare_id!("4azCqYgLHDRmsiR6kmYu6v5qvzamaYGqZcmx8MrnrKMc");

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

        Ok(())
    }
}

// Account size: 8 (disc) + 32 + 32 + 1 + 2 + 8 + 8 + 1 + 1 + 32 = 125
const ATTESTATION_ACCOUNT_SIZE: usize = 125;

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
