use crate::{
    constants::ORACLE_PRICE_SEED,
    error::VaultError,
    events::OraclePriceUpdated,
    state::{MultiAssetVault, OraclePrice},
};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

pub fn initialize_oracle_handler(ctx: Context<InitializeOracle>, price: u64) -> Result<()> {
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

pub fn handler(ctx: Context<UpdateOracle>, price: u64) -> Result<()> {
    require!(price > 0, VaultError::InvalidOracle);

    let clock = Clock::get()?;
    let oracle = &mut ctx.accounts.oracle_price;

    oracle.price = price;
    oracle.updated_at = clock.unix_timestamp;

    emit!(OraclePriceUpdated {
        vault: ctx.accounts.vault.key(),
        asset_mint: ctx.accounts.asset_mint.key(),
        price,
        updated_at: clock.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct InitializeOracle<'info> {
    #[account(has_one = authority)]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = OraclePrice::LEN,
        seeds = [ORACLE_PRICE_SEED, vault.key().as_ref(), asset_mint.key().as_ref()],
        bump,
    )]
    pub oracle_price: Account<'info, OraclePrice>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateOracle<'info> {
    #[account(has_one = authority)]
    pub vault: Account<'info, MultiAssetVault>,

    pub authority: Signer<'info>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [ORACLE_PRICE_SEED, vault.key().as_ref(), asset_mint.key().as_ref()],
        bump = oracle_price.bump,
        has_one = vault,
        has_one = asset_mint,
    )]
    pub oracle_price: Account<'info, OraclePrice>,
}
