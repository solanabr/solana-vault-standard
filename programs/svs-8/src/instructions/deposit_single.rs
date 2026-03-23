use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        mint_to_checked, transfer_checked, Mint, MintToChecked, TokenAccount, TokenInterface,
        TransferChecked,
    },
};
use crate::{
    constants::{MIN_DEPOSIT, MULTI_VAULT_SEED, MAX_ORACLE_STALENESS},
    error::VaultError,
    events::DepositSingle as DepositSingleEvent,
    math::{convert_to_shares, oracle_value_for_amount, total_portfolio_value, Rounding},
    state::{AssetEntry, MultiAssetVault, OraclePrice},
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

    // Validate oracle freshness
    let clock = Clock::get()?;
    let oracle = &ctx.accounts.oracle_price;
    let age = clock.unix_timestamp.saturating_sub(oracle.updated_at) as u64;
    require!(age <= MAX_ORACLE_STALENESS, VaultError::OracleStale);
    require!(oracle.price > 0, VaultError::InvalidOracle);

    // Compute deposit value using real oracle price
    let deposit_value = oracle_value_for_amount(
        oracle.price,
        amount,
        asset_decimals,
        base_decimals,
    )?;
    require!(deposit_value > 0, VaultError::ZeroAmount);

    // Read portfolio from remaining_accounts: pairs of [OraclePrice, vault_token_account]
    let mut balances: Vec<u64> = vec![];
    let mut prices: Vec<u64> = vec![];
    let mut decimals: Vec<u8> = vec![];

    let mut i = 0;
    while i + 1 < ctx.remaining_accounts.len() {
        let oracle_info = &ctx.remaining_accounts[i];
        let vault_ta_info = &ctx.remaining_accounts[i + 1];

        // Read OraclePrice account
        // Deserialize OraclePrice using Anchor's AccountDeserialize — no raw offsets
        let oracle = OraclePrice::from_account_info(oracle_info)?;
        require!(oracle.vault == ctx.accounts.vault.key(), VaultError::InvalidOracle);
        let age = clock.unix_timestamp.saturating_sub(oracle.updated_at) as u64;
        require!(age <= MAX_ORACLE_STALENESS, VaultError::OracleStale);
        require!(oracle.price > 0, VaultError::InvalidOracle);
        prices.push(oracle.price);

        // Read token account balance using typed helper
        let balance = crate::math::read_token_balance(vault_ta_info)?;
        balances.push(balance);
        decimals.push(asset_decimals);

        i += 2;
    }

    let total_value = if balances.is_empty() {
        0u64
    } else {
        total_portfolio_value(&balances, &prices, &decimals, ctx.accounts.vault.base_decimals)?
    };

    let shares = convert_to_shares(deposit_value, total_value, ctx.accounts.shares_mint.supply, ctx.accounts.vault.decimals_offset, Rounding::Floor)?;
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

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint @ VaultError::AssetNotFound,
    )]
    pub shares_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub user_asset_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = shares_mint,
        associated_token::authority = user,
        associated_token::token_program = shares_token_program,
    )]
    pub user_shares_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub shares_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: [OraclePrice, vault_token_account] per OTHER asset in basket
}
