use anchor_lang::prelude::*;

declare_id!("GY7S95LwZ45F3EdkTV5LDwjv1GRkmUfadakd2an6qeSu");

#[program]
pub mod mock_oracle {
    use super::*;

    pub fn create_oracle(ctx: Context<CreateOracle>, vault: Pubkey, price: u64) -> Result<()> {
        let oracle = &mut ctx.accounts.oracle_price;
        oracle.vault = vault;
        oracle.price = price;
        oracle.updated_at = Clock::get()?.unix_timestamp;
        oracle.authority = ctx.accounts.authority.key();
        oracle.bump = 0;
        Ok(())
    }

    pub fn update_oracle(ctx: Context<UpdateOracle>, new_price: u64) -> Result<()> {
        let oracle = &mut ctx.accounts.oracle_price;
        oracle.price = new_price;
        oracle.updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }
}

#[account]
pub struct OraclePrice {
    pub vault: Pubkey,
    pub price: u64,
    pub updated_at: i64,
    pub authority: Pubkey,
    pub bump: u8,
}

impl OraclePrice {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 32 + 1;
}

#[derive(Accounts)]
pub struct CreateOracle<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = OraclePrice::LEN,
    )]
    pub oracle_price: Account<'info, OraclePrice>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateOracle<'info> {
    #[account(
        constraint = oracle_price.authority == authority.key(),
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub oracle_price: Account<'info, OraclePrice>,
}
