use crate::{
    error::VaultError,
    events::AssetRemoved,
    state::{AssetEntry, MultiAssetVault},
};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{TokenAccount, TokenInterface};

pub fn handler(ctx: Context<RemoveAsset>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let asset_entry = &ctx.accounts.asset_entry;

    require!(
        ctx.accounts.asset_vault.amount == 0,
        VaultError::AssetVaultNotEmpty
    );

    let removed_index = asset_entry.index;

    // FIX P2-3: completeness check — all other AssetEntry PDAs must be provided
    let expected_others = vault.num_assets as usize - 1;
    require!(
        ctx.remaining_accounts.len() == expected_others,
        VaultError::AssetNotFound
    );

    // re-index remaining AssetEntry accounts to close index gaps
    // Dedupe remaining_accounts by key to prevent double-decrement on duplicates
    let svs8_id = crate::ID;
    for (i, info) in ctx.remaining_accounts.iter().enumerate() {
        for prev in &ctx.remaining_accounts[..i] {
            require!(prev.key() != info.key(), VaultError::AssetNotFound);
        }
        require!(info.owner == &svs8_id, VaultError::InvalidOracle);
        let mut entry = AssetEntry::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        // V4-P24: Error on wrong-vault remaining_accounts instead of silently skipping
        require!(entry.vault == vault.key(), VaultError::AssetNotFound);
        if entry.index > removed_index {
            entry.index = entry.index.checked_sub(1).ok_or(VaultError::MathOverflow)?;
            let mut data = info.try_borrow_mut_data()?;
            entry.try_serialize(&mut &mut data[..])?;
        }
    }

    vault.num_assets = vault
        .num_assets
        .checked_sub(1)
        .ok_or(VaultError::MathOverflow)?;

    // Remaining weights no longer sum to 10,000 — block deposits until rebalanced
    vault.weights_valid = false;

    emit!(AssetRemoved {
        vault: vault.key(),
        asset_mint: asset_entry.asset_mint,
        index: removed_index,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RemoveAsset<'info> {
    #[account(
        mut,
        has_one = authority,
        seeds = [crate::constants::MULTI_VAULT_SEED, vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, MultiAssetVault>>,

    pub authority: Signer<'info>,

    #[account(
        mut,
        close = authority,
        has_one = vault,
    )]
    pub asset_entry: Box<Account<'info, AssetEntry>>,

    /// V9-P7: Constrain asset_vault to asset_entry.asset_vault to prevent passing
    /// a different empty token account while the real vault ATA still holds tokens.
    #[account(
        mut,
        constraint = asset_vault.key() == asset_entry.asset_vault @ VaultError::AssetNotFound,
        constraint = asset_vault.amount == 0 @ VaultError::AssetVaultNotEmpty,
    )]
    pub asset_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
