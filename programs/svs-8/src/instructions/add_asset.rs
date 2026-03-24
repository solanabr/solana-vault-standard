use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::{ASSET_ENTRY_SEED, MAX_ASSETS, VAULT_SEED, WEIGHT_DENOMINATOR},
    error::VaultError,
    events::AssetAdded,
    remaining::ParsedAssetEntry,
    state::{AssetEntry, MultiAssetVault},
};

#[derive(Accounts)]
pub struct AddAsset<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = vault.authority == authority.key() @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, MultiAssetVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Oracle account — validated by caller off-chain or by staleness check at deposit time
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
        associated_token::mint = asset_mint,
        associated_token::authority = vault,
        associated_token::token_program = asset_token_program,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AddAsset>, target_weight_bps: u16, oracle_type: u8) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(vault.num_assets < MAX_ASSETS, VaultError::MaxAssetsExceeded);

    require!(
        ctx.remaining_accounts.len() == vault.num_assets as usize,
        VaultError::InvalidRemainingAccounts
    );

    let vault_key = vault.key();
    let mut current_total_weight: u16 = 0;
    for account_info in ctx.remaining_accounts.iter() {
        let data = account_info.try_borrow_data()?;
        let entry = ParsedAssetEntry::from_account_data(&data)?;
        entry.validate_pda(account_info.key, &vault_key, &crate::ID)?;

        current_total_weight = current_total_weight
            .checked_add(entry.target_weight_bps)
            .ok_or(error!(VaultError::MathOverflow))?;
    }

    require!(
        current_total_weight
            .checked_add(target_weight_bps)
            .ok_or(error!(VaultError::MathOverflow))?
            <= WEIGHT_DENOMINATOR,
        VaultError::InvalidWeight
    );

    let asset_entry = &mut ctx.accounts.asset_entry;
    asset_entry.vault = vault.key();
    asset_entry.asset_mint = ctx.accounts.asset_mint.key();
    asset_entry.asset_vault = ctx.accounts.asset_vault.key();
    asset_entry.oracle = ctx.accounts.oracle.key();
    asset_entry.oracle_type = oracle_type;
    asset_entry.target_weight_bps = target_weight_bps;
    asset_entry.asset_decimals = ctx.accounts.asset_mint.decimals;
    asset_entry.index = vault.num_assets;
    asset_entry.bump = ctx.bumps.asset_entry;

    vault.num_assets = vault
        .num_assets
        .checked_add(1)
        .ok_or(error!(VaultError::MathOverflow))?;

    emit!(AssetAdded {
        vault: vault.key(),
        asset_mint: ctx.accounts.asset_mint.key(),
        oracle: ctx.accounts.oracle.key(),
        target_weight_bps,
        index: asset_entry.index,
    });

    Ok(())
}
