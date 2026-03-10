use anchor_lang::prelude::*;

use crate::{
    constants::ORACLE_PRICE_SEED,
    error::VaultError,
    events::{AuthorityTransferred, VaultOperatorChanged, VaultStatusChanged},
    state::{AsyncVault, OraclePrice},
};

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, AsyncVault>,
}

pub fn pause(ctx: Context<Admin>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(!vault.paused, VaultError::VaultPaused);
    vault.paused = true;

    emit!(VaultStatusChanged {
        vault: vault.key(),
        paused: true,
    });

    Ok(())
}

pub fn unpause(ctx: Context<Admin>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(vault.paused, VaultError::VaultNotPaused);
    vault.paused = false;

    emit!(VaultStatusChanged {
        vault: vault.key(),
        paused: false,
    });

    Ok(())
}

pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
    require!(
        new_authority != Pubkey::default(),
        VaultError::InvalidAuthority
    );
    let vault = &mut ctx.accounts.vault;
    let previous_authority = vault.authority;
    vault.authority = new_authority;

    emit!(AuthorityTransferred {
        vault: vault.key(),
        previous_authority,
        new_authority,
    });

    Ok(())
}

pub fn set_vault_operator(ctx: Context<Admin>, new_operator: Pubkey) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let previous_operator = vault.operator;
    vault.operator = new_operator;

    emit!(VaultOperatorChanged {
        vault: vault.key(),
        previous_operator,
        new_operator,
    });

    Ok(())
}

// =============================================================================
// Oracle Admin Instructions
// =============================================================================

#[derive(Accounts)]
pub struct InitializeOracle<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        init,
        payer = authority,
        space = OraclePrice::LEN,
        seeds = [ORACLE_PRICE_SEED, vault.key().as_ref()],
        bump,
    )]
    pub oracle_price: Account<'info, OraclePrice>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_oracle(
    ctx: Context<InitializeOracle>,
    initial_price: u64,
    oracle_authority: Pubkey,
) -> Result<()> {
    svs_oracle::validate_price(initial_price).map_err(|_| VaultError::InvalidOraclePrice)?;

    let clock = Clock::get()?;
    let oracle = &mut ctx.accounts.oracle_price;
    oracle.vault = ctx.accounts.vault.key();
    oracle.price = initial_price;
    oracle.updated_at = clock.unix_timestamp;
    oracle.authority = oracle_authority;
    oracle.bump = ctx.bumps.oracle_price;

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateOracle<'info> {
    pub oracle_authority: Signer<'info>,

    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        seeds = [ORACLE_PRICE_SEED, vault.key().as_ref()],
        bump = oracle_price.bump,
        has_one = vault,
        constraint = oracle_price.authority == oracle_authority.key() @ VaultError::Unauthorized,
    )]
    pub oracle_price: Account<'info, OraclePrice>,
}

pub fn update_oracle_price(ctx: Context<UpdateOracle>, new_price: u64) -> Result<()> {
    svs_oracle::validate_price(new_price).map_err(|_| VaultError::InvalidOraclePrice)?;

    let clock = Clock::get()?;
    let oracle = &mut ctx.accounts.oracle_price;
    oracle.price = new_price;
    oracle.updated_at = clock.unix_timestamp;

    Ok(())
}
