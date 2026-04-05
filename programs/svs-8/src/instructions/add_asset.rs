use crate::{
    constants::{ASSET_ENTRY_SEED, MAX_ASSETS},
    error::VaultError,
    events::AssetAdded,
    state::{AssetEntry, MultiAssetVault},
};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

pub fn handler(ctx: Context<AddAsset>, target_weight_bps: u16) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();

    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(target_weight_bps > 0, VaultError::InvalidWeight);
    require!(
        ctx.accounts.vault.num_assets < MAX_ASSETS,
        VaultError::MaxAssetsExceeded
    );

    // Sum weights from remaining_accounts (existing AssetEntry accounts).
    // V5-P15 FIX: Validate remaining_accounts length matches current asset count
    // and error on entries that don't belong to this vault instead of silently skipping.
    require!(
        ctx.remaining_accounts.len() == ctx.accounts.vault.num_assets as usize,
        VaultError::AssetNotFound
    );

    let svs8_id = crate::ID;
    let mut current_total_weight: u16 = 0;
    for (i, info) in ctx.remaining_accounts.iter().enumerate() {
        for prev in &ctx.remaining_accounts[..i] {
            require!(prev.key() != info.key(), VaultError::AssetNotFound);
        }
        require!(info.owner == &svs8_id, VaultError::InvalidOracle);
        let entry = AssetEntry::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        require!(entry.vault == vault_key, VaultError::AssetNotFound);
        current_total_weight = current_total_weight
            .checked_add(entry.target_weight_bps)
            .ok_or(VaultError::MathOverflow)?;
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

    ctx.accounts.vault.num_assets = ctx
        .accounts
        .vault
        .num_assets
        .checked_add(1)
        .ok_or(VaultError::MathOverflow)?;

    // Mark weights as valid only when they sum to exactly 10,000 bps
    ctx.accounts.vault.weights_valid = new_total == 10_000;

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
    #[account(
        mut,
        has_one = authority,
        seeds = [crate::constants::MULTI_VAULT_SEED, vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, MultiAssetVault>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Oracle account - price validated at deposit time
    pub oracle: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = AssetEntry::LEN,
        seeds = [ASSET_ENTRY_SEED, vault.key().as_ref(), asset_mint.key().as_ref()],
        bump,
    )]
    pub asset_entry: Box<Account<'info, AssetEntry>>,

    #[account(
        init,
        payer = authority,
        token::mint = asset_mint,
        token::authority = vault,
        token::token_program = token_program,
    )]
    pub asset_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
