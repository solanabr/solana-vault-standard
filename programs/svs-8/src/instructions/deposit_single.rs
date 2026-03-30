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

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

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

    // Read portfolio from remaining_accounts: [AssetEntry, OraclePrice, vault_ata] per other asset
    // FIX P0-1: include deposited asset vault balance in total_value calculation
    let deposited_balance = ctx.accounts.asset_vault_account.amount;
    let mut balances: Vec<u64> = vec![deposited_balance];
    let mut prices: Vec<u64> = vec![oracle.price];
    let mut decimals: Vec<u8> = vec![asset_decimals];

    // FIX P1-2: split remaining_accounts into asset accounts and module PDAs
    let num_other = ctx.accounts.vault.num_assets as usize - 1;
    let asset_len = num_other * 3;
    require!(
        ctx.remaining_accounts.len() >= asset_len,
        VaultError::AssetNotFound
    );
    let (asset_accounts, _module_accounts) = ctx.remaining_accounts.split_at(asset_len);
    let mut i = 0;
    while i + 2 < asset_accounts.len() + 1 && i / 3 < num_other {
        let asset_entry_info = &asset_accounts[i];
        let oracle_info      = &asset_accounts[i + 1];
        let vault_ta_info    = &asset_accounts[i + 2];

        // Owner checks before deserialization
        let svs8_id = crate::ID;
        let spl_token = anchor_spl::token::ID;
        let spl_token_2022 = anchor_spl::token_2022::ID;
        require!(asset_entry_info.owner == &svs8_id, VaultError::InvalidOracle);
        require!(oracle_info.owner == &svs8_id, VaultError::InvalidOracle);
        require!(
            vault_ta_info.owner == &spl_token || vault_ta_info.owner == &spl_token_2022,
            VaultError::AssetNotFound
        );
        // Validate vault_ta matches asset_entry.asset_vault
        // Validate AssetEntry belongs to this vault
        let other_entry = AssetEntry::try_deserialize(&mut &asset_entry_info.try_borrow_data()?[..])?;
        require!(other_entry.vault == ctx.accounts.vault.key(), VaultError::InvalidOracle);
        require!(vault_ta_info.key() == other_entry.asset_vault, VaultError::AssetNotFound);

        let oracle = OraclePrice::from_account_info(oracle_info)?;
        require!(oracle.vault == ctx.accounts.vault.key(), VaultError::InvalidOracle);
        require!(oracle.asset_mint == other_entry.asset_mint, VaultError::InvalidOracle);
        let age = clock.unix_timestamp.saturating_sub(oracle.updated_at) as u64;
        require!(age <= MAX_ORACLE_STALENESS, VaultError::OracleStale);
        require!(oracle.price > 0, VaultError::InvalidOracle);
        prices.push(oracle.price);

        let balance = crate::math::read_token_balance(vault_ta_info)?;
        balances.push(balance);
        // FIX P0: use per-asset decimals from AssetEntry, not deposited asset decimals
        decimals.push(other_entry.asset_decimals);

        i += 3;
    }

    let total_value = if balances.is_empty() {
        0u64
    } else {
        total_portfolio_value(&balances, &prices, &decimals, ctx.accounts.vault.base_decimals)?
    };

    // ===== Module Hooks (if enabled) =====
    #[cfg(feature = "modules")]
    let net_shares = {
        let remaining = ctx.remaining_accounts;
        let vault_key = ctx.accounts.vault.key();
        let user_key = ctx.accounts.user.key();

        // 1. Access control
        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;

        // 2. Cap enforcement
        module_hooks::check_deposit_caps(
            remaining,
            &crate::ID,
            &vault_key,
            &user_key,
            total_value,
            deposit_value,
        )?;

        // Calculate shares (floor — favors vault)
        let shares = convert_to_shares(
            deposit_value, total_value,
            ctx.accounts.shares_mint.supply,
            ctx.accounts.vault.decimals_offset,
            Rounding::Floor,
        )?;

        // 3. Apply entry fee
        let result = module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    let net_shares = convert_to_shares(
        deposit_value, total_value,
        ctx.accounts.shares_mint.supply,
        ctx.accounts.vault.decimals_offset,
        Rounding::Floor,
    )?;

    require!(net_shares >= min_shares_out, VaultError::SlippageExceeded);
    require!(net_shares > 0, VaultError::ZeroAmount);

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
        net_shares,
        9,
    )?;

    emit!(DepositSingleEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        asset_mint: ctx.accounts.asset_mint.key(),
        amount,
        shares: net_shares,
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
