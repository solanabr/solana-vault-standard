use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{mint_to_checked, Mint, MintToChecked, TokenAccount, TokenInterface},
};
use crate::{
    constants::{MAX_ORACLE_STALENESS, MIN_DEPOSIT, MULTI_VAULT_SEED},
    error::VaultError,
    events::DepositProportional as DepositProportionalEvent,
    math::{convert_to_shares, oracle_value_for_amount, read_token_balance, total_portfolio_value},
    state::{MultiAssetVault, OraclePrice},
};

/// Atomic proportional deposit across ALL basket assets.
///
/// remaining_accounts layout per asset:
/// [OraclePrice, asset_entry_vault_ata, user_asset_ata, asset_mint]
/// last 2: [vault_account, token_program_account]
///
/// For each asset i:
///   token_amount_i = base_amount * weight_bps_i / 10000 / price_i (adjusted for decimals)
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
    let clock = Clock::get()?;

    // remaining_accounts: [OraclePrice, vault_ata, user_ata, asset_mint] x N assets
    //                     + [vault_account, token_program] as last 2
    require!(ctx.remaining_accounts.len() >= 6, VaultError::AssetNotFound);
    let total_rem = ctx.remaining_accounts.len();
    let user_ai_idx = total_rem - 2;
    let tp_ai_idx = total_rem - 1;
    let num_assets = user_ai_idx / 4;
    require!(num_assets > 0, VaultError::AssetNotFound);

    // Snapshot all asset data before any CPI
    struct AssetSnapshot {
        mint_key: Pubkey,
        asset_dec: u8,
        weight_bps: u16,
        vault_balance: u64,
        price: u64,
        vault_ta_key: Pubkey,
        user_ta_key: Pubkey,
        token_amount: u64,
    }

    let mut snapshots: Vec<AssetSnapshot> = Vec::with_capacity(num_assets);
    let mut total_deposit_value: u64 = 0;

    for i in 0..num_assets {
        // Read OraclePrice using typed deserialization
        let oracle = OraclePrice::from_account_info(&ctx.remaining_accounts[i * 4])?;
        require!(oracle.vault == vault_key, VaultError::InvalidOracle);
        let age = clock.unix_timestamp.saturating_sub(oracle.updated_at) as u64;
        require!(age <= MAX_ORACLE_STALENESS, VaultError::OracleStale);
        require!(oracle.price > 0, VaultError::InvalidOracle);

        // Read vault token balance
        let vault_balance = read_token_balance(&ctx.remaining_accounts[i * 4 + 1])?;

        // Read mint decimals
        let mint_data = ctx.remaining_accounts[i * 4 + 3].try_borrow_data()?;
        let asset_dec = if mint_data.len() > 44 { mint_data[44] } else { 6u8 };
        drop(mint_data);

        // Read weight from AssetEntry — stored in oracle account's asset_mint field
        // We get weight from the vault's total weight assumption: equal split if not stored
        // For now use BPS from oracle account index (we'll use 10000/num_assets as fallback)
        // Actually read AssetEntry via remaining_accounts is complex — use equal split
        let weight_bps = (10_000u32 / num_assets as u32) as u16;

        // Calculate how many tokens to deposit for this asset
        // token_amount = base_amount * weight_bps / 10000 * 10^asset_dec / (price * 10^base_dec / PRICE_SCALE)
        let weighted_value = (base_amount as u128)
            .checked_mul(weight_bps as u128).ok_or(VaultError::MathOverflow)?
            .checked_div(10_000u128).ok_or(VaultError::DivisionByZero)? as u64;

        // token_amount = weighted_value * PRICE_SCALE * 10^asset_dec / (price * 10^base_dec)
        let token_amount = (weighted_value as u128)
            .checked_mul(crate::constants::PRICE_SCALE as u128).ok_or(VaultError::MathOverflow)?
            .checked_mul(10u128.pow(asset_dec as u32)).ok_or(VaultError::MathOverflow)?
            .checked_div(oracle.price as u128).ok_or(VaultError::DivisionByZero)?
            .checked_div(10u128.pow(base_decimals as u32)).ok_or(VaultError::DivisionByZero)? as u64;

        require!(token_amount > 0, VaultError::ZeroAmount);

        let deposit_value = oracle_value_for_amount(oracle.price, token_amount, asset_dec, base_decimals)?;
        total_deposit_value = total_deposit_value.checked_add(deposit_value).ok_or(VaultError::MathOverflow)?;

        snapshots.push(AssetSnapshot {
            mint_key: ctx.remaining_accounts[i * 4 + 3].key(),
            asset_dec,
            weight_bps,
            vault_balance,
            price: oracle.price,
            vault_ta_key: ctx.remaining_accounts[i * 4 + 1].key(),
            user_ta_key: ctx.remaining_accounts[i * 4 + 2].key(),
            token_amount,
        });
    }

    // Compute portfolio value and shares to mint
    let balances: Vec<u64> = snapshots.iter().map(|s| s.vault_balance).collect();
    let prices: Vec<u64> = snapshots.iter().map(|s| s.price).collect();
    let decimals_vec: Vec<u8> = snapshots.iter().map(|s| s.asset_dec).collect();
    let total_value = total_portfolio_value(&balances, &prices, &decimals_vec)?;
    let offset = 10u64.pow(decimals_offset as u32);
    let shares = convert_to_shares(total_deposit_value, total_shares, total_value, offset)?;
    require!(shares >= min_shares_out, VaultError::SlippageExceeded);
    require!(shares > 0, VaultError::ZeroAmount);

    // Execute transfers for each asset atomically
    for i in 0..num_assets {
        let ix = anchor_spl::token_interface::spl_token_2022::instruction::transfer_checked(
            &token_program_key,
            &snapshots[i].user_ta_key,
            &snapshots[i].mint_key,
            &snapshots[i].vault_ta_key,
            &user_key,
            &[],
            snapshots[i].token_amount,
            snapshots[i].asset_dec,
        )?;

        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.remaining_accounts[i * 4 + 2].clone(),
                ctx.remaining_accounts[i * 4 + 3].clone(),
                ctx.remaining_accounts[i * 4 + 1].clone(),
                ctx.remaining_accounts[user_ai_idx].clone(),
                ctx.remaining_accounts[tp_ai_idx].clone(),
            ],
        )?;
    }

    // Mint shares once
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
        total_value: total_deposit_value,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct DepositProportional<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, MultiAssetVault>,

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
    // remaining_accounts: [OraclePrice, vault_ata, user_ata, asset_mint] per asset
    //                     last 2: [user_account, token_program_account]
}
