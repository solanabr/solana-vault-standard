use anchor_lang::prelude::*;

declare_id!("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");

#[program]
pub mod mock_sas {
    use super::*;

    pub fn create_attestation(
        ctx: Context<CreateAttestation>,
        credential: Pubkey,
        schema: Pubkey,
        expiry: i64,
    ) -> Result<()> {
        let account_info = ctx.accounts.attestation.to_account_info();
        let mut account_data = account_info.try_borrow_mut_data()?;

        // Borsh-serialized SAS Attestation layout:
        // discriminator(u8) + nonce(32) + credential(32) + schema(32) +
        // data(4 + 0) + signer(32) + expiry(i64) + token_account(32)
        let mut offset = 0;

        // discriminator = 0
        account_data[offset] = 0;
        offset += 1;

        // nonce = default pubkey
        account_data[offset..offset + 32].copy_from_slice(&Pubkey::default().to_bytes());
        offset += 32;

        // credential
        account_data[offset..offset + 32].copy_from_slice(&credential.to_bytes());
        offset += 32;

        // schema
        account_data[offset..offset + 32].copy_from_slice(&schema.to_bytes());
        offset += 32;

        // data = empty vec (length prefix = 0u32)
        account_data[offset..offset + 4].copy_from_slice(&0u32.to_le_bytes());
        offset += 4;

        // signer
        account_data[offset..offset + 32].copy_from_slice(&ctx.accounts.authority.key().to_bytes());
        offset += 32;

        // expiry
        account_data[offset..offset + 8].copy_from_slice(&expiry.to_le_bytes());
        offset += 8;

        // token_account = default pubkey
        account_data[offset..offset + 32].copy_from_slice(&Pubkey::default().to_bytes());

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(credential: Pubkey, schema: Pubkey)]
pub struct CreateAttestation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Raw account written with SAS Attestation layout
    #[account(
        init,
        payer = authority,
        space = 1 + 32 + 32 + 32 + 4 + 32 + 8 + 32,
        seeds = [credential.as_ref(), schema.as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub attestation: UncheckedAccount<'info>,

    /// CHECK: Investor identity for PDA derivation
    pub investor: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
