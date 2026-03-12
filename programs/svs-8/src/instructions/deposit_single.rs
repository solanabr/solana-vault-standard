use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        mint_to_checked, transfer_checked, Mint, MintToChecked, TokenAccount, TokenInterface,
        TransferChecked,
    },
};
use crate::{
    constants::{MIN_DEPOSIT, MULTI_VAULT_SEED},
    error::VaultError,
    events::DepositSingle as DepositSingleEvent,
    math::{convert_to_shares, normalize_price_for_amount, total_portfolio_value},
    state::{MultiAssetVault, AssetEntry},
};

pub fn handler(
    ctx: Context<DepositSingle>,
    amount: u64,
    min_shares_out: u64,
) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(amount >= MIN_DEPOSIT, VaultError::DepositTooSmall);

    let base_decimals = ctx.accounts.vault.base_decimals;
    let asset_decimals = ctx.accounts.asset_entry.asset_decimals;
    let price: u64 = 10u64.pow(base_decimals as u32);

    let deposit_value = normalize_price_for_amount(
        price, 0, amount, asset_decimals, base_decimals,
    )?;

    // Read portfolio from remaining_accounts: pairs of [AssetEntry, TokenAccount]
    let mut balances: Vec<u64> = vec![];
    let mut prices: Vec<u64> = vec![];
    let mut decimals: Vec<u8> = vec![];

    let mut i = 0;
    while i + 1 < ctx.remaining_accounts.len() {
        let entry_info = &ctx.remaining_accounts[i];
        let vault_info = &ctx.remaining_accounts[i + 1];

        // Read asset_decimals from AssetEntry (offset: 8 disc + 32+32+32+32+2+1 = 139, decimals at 139)
        let entry_data = entry_info.try_borrow_data()?;
        if entry_data.len() > 140 {
            let asset_dec = entry_data[139];
            decimals.push(asset_dec);
        } else {
            decimals.push(6);
        }

        // Read amount from TokenAccount (offset 64)
        let vault_data = vault_info.try_borrow_data()?;
        if vault_data.len() >= 72 {
            let amount_bytes: [u8; 8] = vault_data[64..72].try_into()
                .map_err(|_| VaultError::MathOverflow)?;
            balances.push(u64::from_le_bytes(amount_bytes));
        } else {
            balances.push(0);
        }

        prices.push(10u64.pow(base_decimals as u32));
        i += 2;
    }

    let total_value = total_portfolio_value(&balances, &prices, &decimals)?;
    let offset = 10u64.pow(ctx.accounts.vault.decimals_offset as u32);
    let shares = convert_to_shares(
        deposit_value,
        ctx.accounts.vault.total_shares,
        total_value,
        offset,
    )?;
    require!(shares >= min_shares_out, VaultError::SlippageExceeded);
    require!(shares > 0, VaultError::ZeroAmount);

    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_asset_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                to: ctx.accounts.asset_vault_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        asset_decimals,
    )?;

    let signer_seeds: &[&[&[u8]]] = &[&[
        MULTI_VAULT_SEED,
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

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
        .checked_add(shares)
        .ok_or(VaultError::MathOverflow)?;

    emit!(DepositSingleEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        asset_mint: ctx.accounts.asset_mint.key(),
        amount,
        shares,
        deposit_value,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct DepositSingle<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(has_one = vault, has_one = asset_mint)]
    pub asset_entry: Account<'info, AssetEntry>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = asset_vault_account.key() == asset_entry.asset_vault @ VaultError::AssetNotFound,
    )]
    pub asset_vault_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint @ VaultError::AssetNotFound,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

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
