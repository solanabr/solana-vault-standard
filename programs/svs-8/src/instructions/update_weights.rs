use anchor_lang::prelude::*;

use crate::{
    constants::{VAULT_SEED, WEIGHT_DENOMINATOR},
    error::VaultError,
    events::WeightsUpdated,
    remaining::{ParsedAssetEntry, TARGET_WEIGHT_BPS_OFFSET},
    state::MultiAssetVault,
};

#[derive(Accounts)]
pub struct UpdateWeights<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = vault.authority == authority.key() @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, MultiAssetVault>,
}

pub fn handler(ctx: Context<UpdateWeights>, new_weights: Vec<u16>) -> Result<()> {
    let vault = &ctx.accounts.vault;

    require!(
        new_weights.len() == vault.num_assets as usize,
        VaultError::WeightsLengthMismatch
    );

    let total: u32 = new_weights.iter().map(|w| *w as u32).sum();
    require!(
        total == WEIGHT_DENOMINATOR as u32,
        VaultError::WeightsNotFullyAllocated
    );

    require!(
        ctx.remaining_accounts.len() == vault.num_assets as usize,
        VaultError::InvalidRemainingAccounts
    );

    let vault_key = vault.key();

    for (i, account_info) in ctx.remaining_accounts.iter().enumerate() {
        // Validate PDA
        {
            let data = account_info.try_borrow_data()?;
            let entry = ParsedAssetEntry::from_account_data(&data)?;
            entry.validate_pda(account_info.key, &vault_key, &crate::ID)?;
        }

        let mut data = account_info.try_borrow_mut_data()?;
        let weight_bytes = new_weights[i].to_le_bytes();
        data[TARGET_WEIGHT_BPS_OFFSET] = weight_bytes[0];
        data[TARGET_WEIGHT_BPS_OFFSET + 1] = weight_bytes[1];
    }

    emit!(WeightsUpdated {
        vault: vault.key(),
        new_weights,
    });

    Ok(())
}
