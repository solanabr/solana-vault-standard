use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, Burn, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::{ASSET_ENTRY_SEED, VAULT_SEED, WEIGHT_DENOMINATOR},
    error::VaultError,
    events::SingleRedeem,
    math::{portfolio_convert_to_assets, total_portfolio_value, Rounding},
    oracle::read_mock_oracle_price,
    remaining::{read_token_balance, ParsedAssetEntry},
    state::{AssetEntry, MultiAssetVault},
};

#[derive(Accounts)]
pub struct RedeemSingle<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub redeem_asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [ASSET_ENTRY_SEED, vault.key().as_ref(), redeem_asset_mint.key().as_ref()],
        bump = redeem_asset_entry.bump,
        constraint = redeem_asset_entry.vault == vault.key() @ VaultError::AssetNotFound,
    )]
    pub redeem_asset_entry: Account<'info, AssetEntry>,

    #[account(
        mut,
        constraint = redeem_asset_vault.key() == redeem_asset_entry.asset_vault @ VaultError::InvalidAssetVault,
    )]
    pub redeem_asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_redeem_account.mint == redeem_asset_mint.key(),
        constraint = user_redeem_account.owner == user.key(),
    )]
    pub user_redeem_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    // remaining_accounts: [AssetEntry, asset_vault, oracle] × num_assets
}

/// Redeem shares for a single asset using oracle-priced fair value.
///
/// 1. Compute the user's share value in base units via portfolio pricing
/// 2. Convert that value to the chosen asset's quantity using its oracle price
/// 3. Cap at the asset vault's available balance
pub fn handler(ctx: Context<RedeemSingle>, shares: u64, min_amount_out: u64) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);
    require!(
        ctx.accounts.user_shares_account.amount >= shares,
        VaultError::InsufficientShares
    );

    let vault = &ctx.accounts.vault;
    let num_assets = vault.num_assets as usize;

    require!(
        ctx.remaining_accounts.len() == num_assets * 3,
        VaultError::InvalidRemainingAccounts
    );

    let vault_key = vault.key();
    let clock = Clock::get()?;

    let mut weight_sum: u16 = 0;
    let mut balances = Vec::with_capacity(num_assets);
    let mut prices = Vec::with_capacity(num_assets);
    let mut decimals = Vec::with_capacity(num_assets);

    for i in 0..num_assets {
        let entry_info = &ctx.remaining_accounts[i * 3];
        let vault_info = &ctx.remaining_accounts[i * 3 + 1];
        let oracle_info = &ctx.remaining_accounts[i * 3 + 2];

        let entry_data = entry_info.try_borrow_data()?;
        let entry = ParsedAssetEntry::from_account_data(&entry_data)?;
        entry.validate_pda(entry_info.key, &vault_key, &crate::ID)?;

        require!(
            *vault_info.key == entry.asset_vault,
            VaultError::InvalidAssetVault
        );
        require!(*oracle_info.key == entry.oracle, VaultError::OracleInvalid);

        weight_sum = weight_sum
            .checked_add(entry.target_weight_bps)
            .ok_or(error!(VaultError::MathOverflow))?;

        let vault_data = vault_info.try_borrow_data()?;
        balances.push(read_token_balance(&vault_data)?);

        let oracle_data = oracle_info.try_borrow_data()?;
        let price = read_mock_oracle_price(&oracle_data, clock.unix_timestamp)?;
        prices.push(price);

        decimals.push(entry.asset_decimals);
    }

    require!(
        weight_sum == WEIGHT_DENOMINATOR,
        VaultError::WeightsNotFullyAllocated
    );

    let total_value = total_portfolio_value(&balances, &prices, &decimals)?;
    let total_shares = ctx.accounts.shares_mint.supply;

    // Compute the base-unit value the user is entitled to
    let redeem_value = portfolio_convert_to_assets(
        shares,
        total_shares,
        total_value,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    // Convert value to the chosen asset's quantity: amount = value * 10^decimals / price
    let redeem_idx = ctx.accounts.redeem_asset_entry.index as usize;
    require!(redeem_idx < num_assets, VaultError::InvalidAssetEntry);

    let redeem_price = prices[redeem_idx];
    let redeem_decimals = ctx.accounts.redeem_asset_entry.asset_decimals;

    let divisor = 10u128
        .checked_pow(redeem_decimals as u32)
        .ok_or(error!(VaultError::MathOverflow))?;

    // amount_out = redeem_value * 10^decimals / price (floor, favors vault)
    let amount_out_128 = (redeem_value as u128)
        .checked_mul(divisor)
        .ok_or(error!(VaultError::MathOverflow))?
        .checked_div(redeem_price as u128)
        .ok_or(error!(VaultError::DivisionByZero))?;

    let amount_out =
        u64::try_from(amount_out_128).map_err(|_| error!(VaultError::MathOverflow))?;

    let asset_balance = ctx.accounts.redeem_asset_vault.amount;
    require!(amount_out <= asset_balance, VaultError::InsufficientAssets);
    require!(amount_out >= min_amount_out, VaultError::SlippageExceeded);

    // Burn shares
    token_2022::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.to_account_info(),
            Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
    )?;

    // Transfer assets to user
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.redeem_asset_vault.to_account_info(),
                to: ctx.accounts.user_redeem_account.to_account_info(),
                mint: ctx.accounts.redeem_asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        amount_out,
        ctx.accounts.redeem_asset_mint.decimals,
    )?;

    emit!(SingleRedeem {
        vault: vault.key(),
        caller: ctx.accounts.user.key(),
        asset_mint: ctx.accounts.redeem_asset_mint.key(),
        shares,
        amount_out,
    });

    Ok(())
}
