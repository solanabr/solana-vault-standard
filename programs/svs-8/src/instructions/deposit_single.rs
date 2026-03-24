use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, MintTo, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::{ASSET_ENTRY_SEED, MIN_DEPOSIT_AMOUNT, VAULT_SEED, WEIGHT_DENOMINATOR},
    error::VaultError,
    events::SingleDeposit,
    math::{asset_value_in_base, portfolio_convert_to_shares, total_portfolio_value, Rounding},
    oracle::read_mock_oracle_price,
    remaining::{read_token_balance, ParsedAssetEntry},
    state::{AssetEntry, MultiAssetVault},
};

#[derive(Accounts)]
pub struct DepositSingle<'info> {
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
        constraint = shares_mint.key() == vault.shares_mint @ VaultError::InvalidAssetVault,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = shares_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub deposit_asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [ASSET_ENTRY_SEED, vault.key().as_ref(), deposit_asset_mint.key().as_ref()],
        bump = deposit_asset_entry.bump,
        constraint = deposit_asset_entry.vault == vault.key() @ VaultError::AssetNotFound,
    )]
    pub deposit_asset_entry: Account<'info, AssetEntry>,

    #[account(
        mut,
        constraint = deposit_asset_vault.key() == deposit_asset_entry.asset_vault @ VaultError::InvalidAssetVault,
    )]
    pub deposit_asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_deposit_account.mint == deposit_asset_mint.key(),
        constraint = user_deposit_account.owner == user.key(),
    )]
    pub user_deposit_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: [AssetEntry, asset_vault, oracle] × num_assets
}

pub fn handler(ctx: Context<DepositSingle>, amount: u64, min_shares_out: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    require!(amount >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);

    let vault = &ctx.accounts.vault;
    let num_assets = vault.num_assets as usize;

    require!(
        ctx.remaining_accounts.len() == num_assets * 3,
        VaultError::InvalidRemainingAccounts
    );

    let mut weight_sum: u16 = 0;
    let mut balances = Vec::with_capacity(num_assets);
    let mut prices = Vec::with_capacity(num_assets);
    let mut decimals = Vec::with_capacity(num_assets);

    let vault_key = vault.key();
    let clock = Clock::get()?;

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

    let deposit_idx = ctx.accounts.deposit_asset_entry.index as usize;
    require!(deposit_idx < num_assets, VaultError::InvalidAssetEntry);

    let deposit_value = asset_value_in_base(
        amount,
        prices[deposit_idx],
        ctx.accounts.deposit_asset_entry.asset_decimals,
    )?;

    let total_shares = ctx.accounts.shares_mint.supply;
    let shares = portfolio_convert_to_shares(
        deposit_value,
        total_shares,
        total_value,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    require!(shares > 0, VaultError::ZeroAmount);
    require!(shares >= min_shares_out, VaultError::SlippageExceeded);

    transfer_checked(
        CpiContext::new(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_deposit_account.to_account_info(),
                to: ctx.accounts.deposit_asset_vault.to_account_info(),
                mint: ctx.accounts.deposit_asset_mint.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.deposit_asset_mint.decimals,
    )?;

    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    token_2022::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares,
    )?;

    emit!(SingleDeposit {
        vault: vault.key(),
        caller: ctx.accounts.user.key(),
        asset_mint: ctx.accounts.deposit_asset_mint.key(),
        amount,
        shares,
        deposit_value,
    });

    Ok(())
}
