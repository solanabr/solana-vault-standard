use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{mint_to_checked, Mint, MintToChecked, TokenAccount, TokenInterface},
};
use crate::{
    constants::{MIN_DEPOSIT, MULTI_VAULT_SEED},
    error::VaultError,
    events::DepositProportional as DepositProportionalEvent,
    math::{convert_to_shares, total_portfolio_value},
    state::{AssetEntry, MultiAssetVault},
};

pub fn handler(
    ctx: Context<DepositProportional>,
    base_amount: u64,
    min_shares_out: u64,
) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(base_amount >= MIN_DEPOSIT, VaultError::DepositTooSmall);

    let base_decimals = ctx.accounts.vault.base_decimals;
    let total_shares = ctx.accounts.vault.total_shares;
    let decimals_offset = ctx.accounts.vault.decimals_offset;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let vault_key = ctx.accounts.vault.key();
    let user_key = ctx.accounts.user.key();
    let token_program_key = ctx.accounts.token_program.key();

    // Read asset entry data
    let vault_balance = ctx.accounts.asset_vault_ata.amount;

    let asset_dec = ctx.accounts.asset_entry.asset_decimals;
    let weight_bps = ctx.accounts.asset_entry.target_weight_bps;
    let mint_key = ctx.accounts.asset_entry.asset_mint;

    // Single-asset deposit (multi-asset via multiple ix calls)
    let asset_value = (base_amount as u128)
        .checked_mul(weight_bps as u128).ok_or(VaultError::MathOverflow)?
        .checked_div(10_000u128).ok_or(VaultError::DivisionByZero)? as u64;

    let token_amount = (asset_value as u128)
        .checked_mul(10u128.pow(asset_dec as u32)).ok_or(VaultError::MathOverflow)?
        .checked_div(10u64.pow(base_decimals as u32) as u128).ok_or(VaultError::DivisionByZero)? as u64;

    require!(token_amount > 0, VaultError::ZeroAmount);

    let balances = vec![vault_balance];
    let prices = vec![10u64.pow(base_decimals as u32)];
    let decimals = vec![asset_dec];
    let total_value = total_portfolio_value(&balances, &prices, &decimals)?;
    let offset = 10u64.pow(decimals_offset as u32);

    let shares = convert_to_shares(asset_value, total_shares, total_value, offset)?;
    require!(shares >= min_shares_out, VaultError::SlippageExceeded);
    require!(shares > 0, VaultError::ZeroAmount);

    // Transfer token from user to vault
    let ix = anchor_spl::token_interface::spl_token_2022::instruction::transfer_checked(
        &token_program_key,
        &ctx.accounts.user_asset_ata.key(),
        &mint_key,
        &ctx.accounts.asset_vault_ata.key(),
        &user_key,
        &[],
        token_amount,
        asset_dec,
    )?;

    anchor_lang::solana_program::program::invoke(
        &ix,
        &[
            ctx.accounts.user_asset_ata.to_account_info(),
            ctx.accounts.asset_mint.to_account_info(),
            ctx.accounts.asset_vault_ata.to_account_info(),
            ctx.accounts.user.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
    )?;

    // Mint shares
    let signer_seeds: &[&[&[u8]]] = &[&[MULTI_VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    mint_to_checked(
        CpiContext::new_with_signer(
            ctx.accounts.shares_token_program.to_account_info(),
            MintToChecked {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares,
        9,
    )?;

    ctx.accounts.vault.total_shares = ctx.accounts.vault.total_shares
        .checked_add(shares).ok_or(VaultError::MathOverflow)?;

    emit!(DepositProportionalEvent {
        vault: vault_key,
        caller: user_key,
        base_amount,
        shares,
        total_value: asset_value,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct DepositProportional<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, MultiAssetVault>,

    pub asset_entry: Account<'info, AssetEntry>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_asset_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub asset_vault_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = shares_mint.key() == vault.shares_mint @ VaultError::AssetNotFound)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = shares_mint,
        associated_token::authority = user,
        associated_token::token_program = shares_token_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub shares_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
