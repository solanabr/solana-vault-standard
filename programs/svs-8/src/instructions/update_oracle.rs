use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use crate::{
    constants::ORACLE_PRICE_SEED,
    error::VaultError,
    events::OraclePriceUpdated,
    state::{MultiAssetVault, OraclePrice},
};

pub fn handler(ctx: Context<UpdateOracle>, price: u64) -> Result<()> {
    require!(price > 0, VaultError::InvalidOracle);

    let clock = Clock::get()?;
    let oracle = &mut ctx.accounts.oracle_price;

    oracle.vault = ctx.accounts.vault.key();
    oracle.asset_mint = ctx.accounts.asset_mint.key();
    oracle.price = price;
    oracle.updated_at = clock.unix_timestamp;
    oracle.authority = ctx.accounts.authority.key();
    oracle.bump = ctx.bumps.oracle_price;

    emit!(OraclePriceUpdated {
        vault: ctx.accounts.vault.key(),
        asset_mint: ctx.accounts.asset_mint.key(),
        price,
        updated_at: clock.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateOracle<'info> {
    #[account(has_one = authority)]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = authority,
        space = OraclePrice::LEN,
        seeds = [ORACLE_PRICE_SEED, vault.key().as_ref(), asset_mint.key().as_ref()],
        bump,
    )]
    pub oracle_price: Account<'info, OraclePrice>,

    pub system_program: Program<'info, System>,
}
