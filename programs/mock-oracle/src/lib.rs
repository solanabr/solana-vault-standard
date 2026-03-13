use anchor_lang::prelude::*;

declare_id!("EbFcZZApkGcX6LqRmzSWVLasnDM457wY4WvhJRnVjdZF");

#[program]
pub mod mock_oracle {
    use super::*;

    pub fn set_price(ctx: Context<SetPrice>, price: u64) -> Result<()> {
        let oracle = &mut ctx.accounts.oracle_data;
        oracle.price_per_share = price;
        oracle.updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn update_timestamp(ctx: Context<UpdateTimestamp>, timestamp: i64) -> Result<()> {
        let oracle = &mut ctx.accounts.oracle_data;
        oracle.updated_at = timestamp;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + 16,
        seeds = [b"oracle"],
        bump,
    )]
    pub oracle_data: Account<'info, OracleData>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateTimestamp<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"oracle"],
        bump,
    )]
    pub oracle_data: Account<'info, OracleData>,
}

#[account]
pub struct OracleData {
    pub price_per_share: u64,
    pub updated_at: i64,
}
