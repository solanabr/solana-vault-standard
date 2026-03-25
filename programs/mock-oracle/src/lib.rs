use anchor_lang::prelude::*;

declare_id!("EbFcZZApkGcX6LqRmzSWVLasnDM457wY4WvhJRnVjdZF");

#[program]
pub mod mock_oracle {
    use super::*;

    pub fn set_price(ctx: Context<SetPrice>, price: u64) -> Result<()> {
        require!(price > 0, OracleError::InvalidPrice);

        let oracle = &mut ctx.accounts.oracle_data;
        let is_new = oracle.vault == Pubkey::default();

        if is_new {
            oracle.vault = ctx.accounts.vault.key();
            oracle.authority = ctx.accounts.authority.key();
            oracle.version = 1;
        } else {
            require!(
                ctx.accounts.authority.key() == oracle.authority,
                OracleError::Unauthorized
            );
        }

        oracle.price_per_share = price;
        oracle.updated_at = Clock::get()?.unix_timestamp;

        Ok(())
    }

    pub fn update_timestamp(ctx: Context<UpdateTimestamp>, timestamp: i64) -> Result<()> {
        let oracle = &mut ctx.accounts.oracle_data;
        require!(
            ctx.accounts.authority.key() == oracle.authority,
            OracleError::Unauthorized
        );
        oracle.updated_at = timestamp;
        Ok(())
    }

    pub fn transfer_authority(
        ctx: Context<TransferAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        let oracle = &mut ctx.accounts.oracle_data;
        require!(
            ctx.accounts.authority.key() == oracle.authority,
            OracleError::Unauthorized
        );
        oracle.authority = new_authority;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Used only for PDA seed derivation.
    pub vault: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + OracleData::LEN,
        seeds = [b"oracle", vault.key().as_ref()],
        bump,
    )]
    pub oracle_data: Account<'info, OracleData>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateTimestamp<'info> {
    pub authority: Signer<'info>,

    /// CHECK: Used only for PDA seed derivation.
    pub vault: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"oracle", vault.key().as_ref()],
        bump,
    )]
    pub oracle_data: Account<'info, OracleData>,
}

#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    pub authority: Signer<'info>,

    /// CHECK: Used only for PDA seed derivation.
    pub vault: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"oracle", vault.key().as_ref()],
        bump,
    )]
    pub oracle_data: Account<'info, OracleData>,
}

#[account]
pub struct OracleData {
    pub price_per_share: u64,
    pub updated_at: i64,
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub version: u8,
}

impl OracleData {
    pub const LEN: usize = 8 + 8 + 32 + 32 + 1;
}

#[error_code]
pub enum OracleError {
    #[msg("Signer is not the oracle authority")]
    Unauthorized,
    #[msg("Price must be greater than zero")]
    InvalidPrice,
}
