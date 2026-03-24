use anchor_lang::prelude::*;
use anchor_spl::token_interface::{burn_checked, BurnChecked, Mint, TokenAccount, TokenInterface};
use crate::{
    constants::{MAX_ORACLE_STALENESS, MULTI_VAULT_SEED},
    error::VaultError,
    events::RedeemProportional as RedeemSingleEvent,
    math::{oracle_value_for_amount, total_portfolio_value},
    state::{AssetEntry, MultiAssetVault, OraclePrice},
};

/// Redeem shares for a single specific asset.
/// The user burns shares and receives only the chosen asset,
/// proportional to its share of the portfolio value.
pub fn handler(
    ctx: Context<RedeemSingle>,
    shares: u64,
    min_assets_out: u64,
) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(shares > 0, VaultError::ZeroAmount);
    require!(shares <= ctx.accounts.shares_mint.supply, VaultError::InsufficientShares);

    let clock = Clock::get()?;
    let oracle = &ctx.accounts.oracle_price;
    let age = clock.unix_timestamp.saturating_sub(oracle.updated_at) as u64;
    require!(age <= MAX_ORACLE_STALENESS, VaultError::OracleStale);
    require!(oracle.price > 0, VaultError::InvalidOracle);

    let base_decimals = ctx.accounts.vault.base_decimals;
    let asset_decimals = ctx.accounts.asset_entry.asset_decimals;
    let total_shares = ctx.accounts.shares_mint.supply;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let vault_key = ctx.accounts.vault.key();

    // Compute vault balance value for this asset
    let vault_balance = ctx.accounts.asset_vault_account.amount;
    let _asset_value = oracle_value_for_amount(oracle.price, vault_balance, asset_decimals, base_decimals)?;

    // Total portfolio value — use remaining_accounts: [OraclePrice, vault_ata, asset_mint] per other asset

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;
    let mut balances: Vec<u64> = vec![vault_balance];
    let mut prices: Vec<u64> = vec![oracle.price];
    let mut decimals_vec: Vec<u8> = vec![asset_decimals];

    let rem = ctx.remaining_accounts;
    let num_other = rem.len() / 3;
    for i in 0..num_other {
        let other_oracle = OraclePrice::from_account_info(&rem[i * 3])?;
        let other_age = clock.unix_timestamp.saturating_sub(other_oracle.updated_at) as u64;
        require!(other_age <= MAX_ORACLE_STALENESS, VaultError::OracleStale);
        require!(other_oracle.price > 0, VaultError::InvalidOracle);

        let bal = crate::math::read_token_balance(&rem[i * 3 + 1])?;
        let mint_data = rem[i * 3 + 2].try_borrow_data()?;
        let dec = if mint_data.len() > 44 { mint_data[44] } else { 6u8 };
        drop(mint_data);

        balances.push(bal);
        prices.push(other_oracle.price);
        decimals_vec.push(dec);
    }

    let total_value = total_portfolio_value(&balances, &prices, &decimals_vec, ctx.accounts.vault.base_decimals)?;

    // token_amount = vault_balance * shares / total_shares (floor — favors vault)
    // This is equivalent to redeeming the share of this asset proportional to shares burned
    let token_amount = if total_shares == 0 {
        0u64
    } else {
        (vault_balance as u128)
            .checked_mul(shares as u128).ok_or(VaultError::MathOverflow)?
            .checked_div(total_shares as u128).ok_or(VaultError::DivisionByZero)? as u64
    };

    let redeem_value = total_value
        .checked_mul(shares as u64).unwrap_or(u64::MAX)
        .checked_div(total_shares).unwrap_or(0);

    // ===== Module Hooks (if enabled) =====
    #[cfg(feature = "modules")]
    let net_token_amount = {
        let remaining = ctx.remaining_accounts;
        let vault_key = ctx.accounts.vault.key();
        let user_key = ctx.accounts.user.key();
        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;
        module_hooks::check_share_lock(remaining, &crate::ID, &vault_key, &user_key)?;
        let result = module_hooks::apply_exit_fee(remaining, &crate::ID, &vault_key, token_amount)?;
        result.net_assets
    };

    #[cfg(not(feature = "modules"))]
    let net_token_amount = token_amount;

    require!(net_token_amount >= min_assets_out, VaultError::SlippageExceeded);
    require!(net_token_amount > 0, VaultError::ZeroAmount);
    require!(net_token_amount <= vault_balance, VaultError::InsufficientShares);

    // Transfer asset from vault to user
    let signer_seeds: &[&[&[u8]]] = &[&[MULTI_VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];
    let token_program_key = ctx.accounts.token_program.key();
    let mint_key = ctx.accounts.asset_mint.key();

    let ix = anchor_spl::token_interface::spl_token_2022::instruction::transfer_checked(
        &token_program_key,
        &ctx.accounts.asset_vault_account.key(),
        &mint_key,
        &ctx.accounts.user_asset_account.key(),
        &vault_key,
        &[],
        token_amount,
        asset_decimals,
    )?;

    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[
            ctx.accounts.asset_vault_account.to_account_info(),
            ctx.accounts.asset_mint.to_account_info(),
            ctx.accounts.user_asset_account.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        signer_seeds,
    )?;

    // Burn shares
    burn_checked(
        CpiContext::new(
            ctx.accounts.shares_token_program.to_account_info(),
            BurnChecked {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
        9,
    )?;


    emit!(RedeemSingleEvent {
        vault: vault_key,
        caller: ctx.accounts.user.key(),
        shares,
        total_value: redeem_value,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RedeemSingle<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub vault: Box<Account<'info, MultiAssetVault>>,

    #[account(has_one = vault, has_one = asset_mint)]
    pub asset_entry: Box<Account<'info, AssetEntry>>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [
            crate::constants::ORACLE_PRICE_SEED,
            vault.key().as_ref(),
            asset_mint.key().as_ref(),
        ],
        bump = oracle_price.bump,
        constraint = oracle_price.vault == vault.key() @ VaultError::InvalidOracle,
        constraint = oracle_price.asset_mint == asset_mint.key() @ VaultError::InvalidOracle,
    )]
    pub oracle_price: Box<Account<'info, OraclePrice>>,

    #[account(
        mut,
        constraint = asset_vault_account.key() == asset_entry.asset_vault @ VaultError::AssetNotFound,
    )]
    pub asset_vault_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub user_asset_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, constraint = shares_mint.key() == vault.shares_mint @ VaultError::AssetNotFound)]
    pub shares_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub user_shares_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub shares_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: [OraclePrice, vault_ata, asset_mint] per OTHER asset in basket
}
