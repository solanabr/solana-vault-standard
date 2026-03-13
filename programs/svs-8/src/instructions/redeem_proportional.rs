use anchor_lang::prelude::*;
use anchor_spl::token_interface::{burn_checked, BurnChecked, Mint, TokenAccount, TokenInterface};
use crate::{
    constants::MULTI_VAULT_SEED,
    error::VaultError,
    events::RedeemProportional as RedeemProportionalEvent,
    math::{convert_to_assets, total_portfolio_value},
    state::{AssetEntry, MultiAssetVault},
};

pub fn handler(
    ctx: Context<RedeemProportional>,
    shares: u64,
    min_assets_out: u64,
) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(shares > 0, VaultError::ZeroAmount);

    let base_decimals = ctx.accounts.vault.base_decimals;
    let total_shares = ctx.accounts.vault.total_shares;
    let decimals_offset = ctx.accounts.vault.decimals_offset;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let vault_key = ctx.accounts.vault.key();
    let token_program_key = ctx.accounts.token_program.key();

    require!(shares <= total_shares, VaultError::InsufficientShares);

    let vault_balance = ctx.accounts.asset_vault_ata.amount;

    let asset_dec = ctx.accounts.asset_entry.asset_decimals;
    let mint_key = ctx.accounts.asset_entry.asset_mint;

    let balances = vec![vault_balance];
    let prices = vec![10u64.pow(base_decimals as u32)];
    let decimals = vec![asset_dec];
    let total_value = total_portfolio_value(&balances, &prices, &decimals)?;
    let offset = 10u64.pow(decimals_offset as u32);

    let redeem_value = convert_to_assets(shares, total_shares, total_value, offset)?;
    require!(redeem_value >= min_assets_out, VaultError::SlippageExceeded);

    let asset_out = (vault_balance as u128)
        .checked_mul(shares as u128).ok_or(VaultError::MathOverflow)?
        .checked_div(total_shares as u128).ok_or(VaultError::DivisionByZero)? as u64;

    require!(asset_out > 0, VaultError::ZeroAmount);

    // Transfer from vault to user
    let signer_seeds: &[&[&[u8]]] = &[&[MULTI_VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    let ix = anchor_spl::token_interface::spl_token_2022::instruction::transfer_checked(
        &token_program_key,
        &ctx.accounts.asset_vault_ata.key(),
        &mint_key,
        &ctx.accounts.user_asset_ata.key(),
        &vault_key,
        &[],
        asset_out,
        asset_dec,
    )?;

    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[
            ctx.accounts.asset_vault_ata.to_account_info(),
            ctx.accounts.asset_mint.to_account_info(),
            ctx.accounts.user_asset_ata.to_account_info(),
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

    ctx.accounts.vault.total_shares = ctx.accounts.vault.total_shares
        .checked_sub(shares).ok_or(VaultError::MathOverflow)?;

    emit!(RedeemProportionalEvent {
        vault: vault_key,
        caller: ctx.accounts.user.key(),
        shares,
        total_value: redeem_value,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RedeemProportional<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, MultiAssetVault>,

    pub asset_entry: Account<'info, AssetEntry>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub asset_vault_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub user_asset_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = shares_mint.key() == vault.shares_mint @ VaultError::AssetNotFound)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub shares_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
