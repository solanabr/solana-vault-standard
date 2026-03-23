use anchor_lang::prelude::*;

use crate::{constants::VAULT_SEED, error::VaultError, state::MultiAssetVault};

#[derive(Accounts)]
pub struct SetOracleData<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = vault.authority == authority.key() @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, MultiAssetVault>,

    /// CHECK: Oracle account to write data to — must be owned by this program
    #[account(
        mut,
        constraint = oracle.owner == &crate::ID @ VaultError::OracleInvalid,
    )]
    pub oracle: AccountInfo<'info>,
}

pub fn handler(ctx: Context<SetOracleData>, price: u64, timestamp: i64) -> Result<()> {
    require!(price > 0, VaultError::OracleInvalid);

    let oracle = &ctx.accounts.oracle;
    let mut data = oracle.try_borrow_mut_data()?;

    require!(data.len() >= 16, VaultError::OracleInvalid);

    data[0..8].copy_from_slice(&price.to_le_bytes());
    data[8..16].copy_from_slice(&timestamp.to_le_bytes());

    Ok(())
}
