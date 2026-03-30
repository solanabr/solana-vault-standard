use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::{
    constants::{ASSET_ENTRY_SEED, MAX_ASSETS},
    error::VaultError,
    events::AssetAdded,
    state::{AssetEntry, MultiAssetVault},
};

pub fn handler(ctx: Context<AddAsset>, target_weight_bps: u16) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();

    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(ctx.accounts.vault.num_assets < MAX_ASSETS, VaultError::MaxAssetsExceeded);

    // Sum weights from remaining_accounts (existing AssetEntry accounts)
    // FIX P1: typed deserialization with owner + vault checks instead of raw byte offsets
    let svs8_id = crate::ID;
    let mut current_total_weight: u16 = 0;
    for info in ctx.remaining_accounts.iter() {
        require!(info.owner == &svs8_id, VaultError::InvalidOracle);
        let entry = AssetEntry::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        if entry.vault == vault_key {
            current_total_weight = current_total_weight
                .checked_add(entry.target_weight_bps)
                .ok_or(VaultError::MathOverflow)?;
        }
    }

    let new_total = current_total_weight
        .checked_add(target_weight_bps)
        .ok_or(VaultError::MathOverflow)?;
    require!(new_total <= 10_000, VaultError::InvalidWeight);

    let index = ctx.accounts.vault.num_assets;
    let asset_decimals = ctx.accounts.asset_mint.decimals;
    let asset_mint_key = ctx.accounts.asset_mint.key();
    let asset_vault_key = ctx.accounts.asset_vault.key();
    let oracle_key = ctx.accounts.oracle.key();
    let bump = ctx.bumps.asset_entry;

    let asset_entry = &mut ctx.accounts.asset_entry;
    asset_entry.vault = vault_key;
    asset_entry.asset_mint = asset_mint_key;
    asset_entry.asset_vault = asset_vault_key;
    asset_entry.oracle = oracle_key;
    asset_entry.target_weight_bps = target_weight_bps;
    asset_entry.asset_decimals = asset_decimals;
    asset_entry.index = index;
    asset_entry.bump = bump;

    ctx.accounts.vault.num_assets = ctx.accounts.vault.num_assets
        .checked_add(1)
        .ok_or(VaultError::MathOverflow)?;

    emit!(AssetAdded {
        vault: vault_key,
        asset_mint: asset_mint_key,
        oracle: oracle_key,
        target_weight_bps,
        index,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct AddAsset<'info> {
    #[account(mut, has_one = authority)]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Oracle account - price validated at deposit time
    pub oracle: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = AssetEntry::LEN,
        seeds = [ASSET_ENTRY_SEED, vault.key().as_ref(), asset_mint.key().as_ref()],
        bump,
    )]
    pub asset_entry: Account<'info, AssetEntry>,

    #[account(
        init,
        payer = authority,
        token::mint = asset_mint,
        token::authority = vault,
        token::token_program = token_program,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
