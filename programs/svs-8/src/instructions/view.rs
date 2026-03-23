use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token_interface::Mint;

use crate::{
    constants::{ASSET_ENTRY_SEED, VAULT_SEED},
    error::VaultError,
    math::{
        asset_value_in_base, portfolio_convert_to_assets, portfolio_convert_to_shares,
        total_portfolio_value, Rounding,
    },
    state::{AssetEntry, MultiAssetVault},
};

#[derive(Accounts)]
pub struct VaultView<'info> {
    #[account(
        seeds = [VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,
    // remaining_accounts: [AssetEntry, asset_vault, oracle] × num_assets
}

/// Helper: read all asset data from remaining_accounts
fn read_asset_data(
    remaining: &[AccountInfo],
    num_assets: usize,
    vault_key: &Pubkey,
    program_id: &Pubkey,
    current_timestamp: i64,
) -> Result<(Vec<u64>, Vec<u64>, Vec<u8>)> {
    let mut balances = Vec::with_capacity(num_assets);
    let mut prices = Vec::with_capacity(num_assets);
    let mut decimals = Vec::with_capacity(num_assets);

    for i in 0..num_assets {
        let entry_info = &remaining[i * 3];
        let vault_info = &remaining[i * 3 + 1];
        let oracle_info = &remaining[i * 3 + 2];

        let entry_data = entry_info.try_borrow_data()?;
        if entry_data.len() < AssetEntry::LEN {
            return Err(error!(VaultError::InvalidAssetEntry));
        }
        // Read asset_mint from entry data (offset 8 + 32 = 40, 32 bytes)
        let asset_mint = Pubkey::try_from(&entry_data[40..72])
            .map_err(|_| error!(VaultError::InvalidAssetEntry))?;
        let asset_decimals = entry_data[137 + 2]; // offset: 8+32+32+32+32+1+2 = 139

        let (expected_pda, _) = Pubkey::find_program_address(
            &[ASSET_ENTRY_SEED, vault_key.as_ref(), asset_mint.as_ref()],
            program_id,
        );
        require!(
            entry_info.key() == expected_pda,
            VaultError::InvalidAssetEntry
        );

        // Read balance from token account
        let vault_account_data = vault_info.try_borrow_data()?;
        // SPL Token account: amount is at offset 64 (8 bytes, little-endian)
        if vault_account_data.len() < 72 {
            return Err(error!(VaultError::InvalidAssetVault));
        }
        let amount_bytes: [u8; 8] = vault_account_data[64..72]
            .try_into()
            .map_err(|_| error!(VaultError::InvalidAssetVault))?;
        balances.push(u64::from_le_bytes(amount_bytes));

        // Read oracle price
        let oracle_data = oracle_info.try_borrow_data()?;
        let price = crate::instructions::deposit_single::read_mock_oracle_price(
            &oracle_data,
            current_timestamp,
        )?;
        prices.push(price);
        decimals.push(asset_decimals);
    }

    Ok((balances, prices, decimals))
}

/// Preview deposit_single: how many shares for a given amount of one asset
pub fn preview_deposit(ctx: Context<VaultView>, asset_index: u8, amount: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let num_assets = vault.num_assets as usize;
    let vault_key = vault.key();
    let clock = Clock::get()?;

    require!(
        ctx.remaining_accounts.len() == num_assets * 3,
        VaultError::InvalidRemainingAccounts
    );

    let (balances, prices, asset_decimals_vec) = read_asset_data(
        ctx.remaining_accounts,
        num_assets,
        &vault_key,
        &crate::ID,
        clock.unix_timestamp,
    )?;

    let total_value = total_portfolio_value(&balances, &prices, &asset_decimals_vec)?;
    let deposit_value = asset_value_in_base(
        amount,
        prices[asset_index as usize],
        asset_decimals_vec[asset_index as usize],
    )?;
    let total_shares = ctx.accounts.shares_mint.supply;

    let shares = portfolio_convert_to_shares(
        deposit_value,
        total_shares,
        total_value,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    set_return_data(&shares.to_le_bytes());
    Ok(())
}

/// Get total portfolio value in base units
pub fn get_total_portfolio_value(ctx: Context<VaultView>) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let num_assets = vault.num_assets as usize;
    let vault_key = vault.key();
    let clock = Clock::get()?;

    require!(
        ctx.remaining_accounts.len() == num_assets * 3,
        VaultError::InvalidRemainingAccounts
    );

    let (balances, prices, asset_decimals_vec) = read_asset_data(
        ctx.remaining_accounts,
        num_assets,
        &vault_key,
        &crate::ID,
        clock.unix_timestamp,
    )?;

    let total_value = total_portfolio_value(&balances, &prices, &asset_decimals_vec)?;
    set_return_data(&total_value.to_le_bytes());
    Ok(())
}

/// Preview redeem: how many assets of one type for given shares
pub fn preview_redeem_single(ctx: Context<VaultView>, asset_index: u8, shares: u64) -> Result<()> {
    let num_assets = ctx.accounts.vault.num_assets as usize;
    let vault_key = ctx.accounts.vault.key();

    require!(
        ctx.remaining_accounts.len() == num_assets * 3,
        VaultError::InvalidRemainingAccounts
    );

    let total_shares = ctx.accounts.shares_mint.supply;
    let mut amount_out: u64 = 0;

    for i in 0..num_assets {
        let entry_info = &ctx.remaining_accounts[i * 3];
        let vault_info = &ctx.remaining_accounts[i * 3 + 1];

        let entry_data = entry_info.try_borrow_data()?;
        if entry_data.len() < AssetEntry::LEN {
            return Err(error!(VaultError::InvalidAssetEntry));
        }
        let asset_mint = Pubkey::try_from(&entry_data[40..72])
            .map_err(|_| error!(VaultError::InvalidAssetEntry))?;
        // index is at offset 8+32+32+32+32+1+2+1 = 140
        let index = entry_data[140];

        let (expected_pda, _) = Pubkey::find_program_address(
            &[ASSET_ENTRY_SEED, vault_key.as_ref(), asset_mint.as_ref()],
            &crate::ID,
        );
        require!(
            entry_info.key() == expected_pda,
            VaultError::InvalidAssetEntry
        );

        if index == asset_index {
            let vault_data = vault_info.try_borrow_data()?;
            if vault_data.len() < 72 {
                return Err(error!(VaultError::InvalidAssetVault));
            }
            let amount_bytes: [u8; 8] = vault_data[64..72]
                .try_into()
                .map_err(|_| error!(VaultError::InvalidAssetVault))?;
            let balance = u64::from_le_bytes(amount_bytes);
            amount_out = crate::math::mul_div(shares, balance, total_shares, Rounding::Floor)?;
            break;
        }
    }

    set_return_data(&amount_out.to_le_bytes());
    Ok(())
}

/// Convert shares to base-unit value
pub fn convert_shares_to_value(ctx: Context<VaultView>, shares: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let num_assets = vault.num_assets as usize;
    let vault_key = vault.key();
    let clock = Clock::get()?;

    require!(
        ctx.remaining_accounts.len() == num_assets * 3,
        VaultError::InvalidRemainingAccounts
    );

    let (balances, prices, asset_decimals_vec) = read_asset_data(
        ctx.remaining_accounts,
        num_assets,
        &vault_key,
        &crate::ID,
        clock.unix_timestamp,
    )?;

    let total_value = total_portfolio_value(&balances, &prices, &asset_decimals_vec)?;
    let total_shares = ctx.accounts.shares_mint.supply;

    let value = portfolio_convert_to_assets(
        shares,
        total_shares,
        total_value,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    set_return_data(&value.to_le_bytes());
    Ok(())
}
