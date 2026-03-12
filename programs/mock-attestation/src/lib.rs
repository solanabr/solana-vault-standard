use anchor_lang::prelude::*;

declare_id!("3hkiaCkrdWay9xJzGYEZ69H4H1xnUrcy9ABwcuYNs1NK");

#[program]
pub mod mock_attestation {
    use super::*;

    pub fn create_attestation(
        ctx: Context<CreateAttestation>,
        subject: Pubkey,
        issuer: Pubkey,
        attestation_type: u8,
        country_code: [u8; 2],
        expires_at: i64,
    ) -> Result<()> {
        let att = &mut ctx.accounts.attestation;
        att.subject = subject;
        att.issuer = issuer;
        att.attestation_type = attestation_type;
        att.country_code = country_code;
        att.issued_at = Clock::get()?.unix_timestamp;
        att.expires_at = expires_at;
        att.revoked = false;
        att.bump = 0;
        att._reserved = [0u8; 32];
        Ok(())
    }

    pub fn revoke_attestation(ctx: Context<RevokeAttestation>) -> Result<()> {
        let att = &mut ctx.accounts.attestation;
        att.revoked = true;
        Ok(())
    }
}

#[account]
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
}

impl Attestation {
    pub const LEN: usize = 8 + 32 + 32 + 1 + 2 + 8 + 8 + 1 + 1 + 32;
}

#[derive(Accounts)]
pub struct CreateAttestation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Attestation::LEN,
    )]
    pub attestation: Account<'info, Attestation>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeAttestation<'info> {
    pub authority: Signer<'info>,

    #[account(mut)]
    pub attestation: Account<'info, Attestation>,
}
