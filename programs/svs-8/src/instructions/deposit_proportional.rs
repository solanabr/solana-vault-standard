use anchor_lang::prelude::*;
use anchor_spl::token_interface::{mint_to_checked, Mint, MintToChecked, TokenAccount, TokenInterface};
use crate::{
    constants::{MAX_ORACLE_STALENESS, MIN_DEPOSIT, MULTI_VAULT_SEED, PRICE_SCALE},
    error::VaultError,
    events::DepositProportional as DepositProportionalEvent,
    math::{convert_to_shares, oracle_value_for_amount, total_portfolio_value, Rounding},
    state::{AssetEntry, MultiAssetVault, OraclePrice},
};

/// Atomic proportional deposit across ALL basket assets.
///
/// remaining_accounts layout per asset (quintuplets):
///   [AssetEntry PDA, OraclePrice PDA, vault_ata, user_ata, mint]  x  num_assets
pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DepositProportional<'info>>,
    base_amount: u64,
    min_shares_out: u64,
) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(base_amount >= MIN_DEPOSIT, VaultError::DepositTooSmall);

    let vault_key = ctx.accounts.vault.key();
    let svs8_program_id = crate::ID;
    let spl_token = anchor_spl::token::ID;
    let spl_token_2022 = anchor_spl::token_2022::ID;
    let clock = Clock::get()?;
    let base_decimals = ctx.accounts.vault.base_decimals;
    let decimals_offset = ctx.accounts.vault.decimals_offset;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;

    require!(
        ctx.remaining_accounts.len() % 5 == 0 && ctx.remaining_accounts.len() > 0,
        VaultError::AssetNotFound
    );
    let num_assets = ctx.remaining_accounts.len() / 5;

    struct AssetSnapshot {
        weight_bps: u16,
        asset_dec: u8,
        vault_balance: u64,
        price: u64,
        mint_key: Pubkey,
        vault_ta_key: Pubkey,
        user_ta_key: Pubkey,
        token_amount: u64,
        deposit_value: u64,
        idx: usize,
    }

    let mut snapshots: Vec<AssetSnapshot> = Vec::with_capacity(num_assets);
    let mut total_deposit_value: u64 = 0;

    for i in 0..num_assets {
        let asset_entry_ai = &ctx.remaining_accounts[i * 5];
        let oracle_ai     = &ctx.remaining_accounts[i * 5 + 1];
        let vault_ta_ai   = &ctx.remaining_accounts[i * 5 + 2];
        let user_ta_ai    = &ctx.remaining_accounts[i * 5 + 3];

        // Owner checks
        require!(asset_entry_ai.owner == &svs8_program_id, VaultError::InvalidOracle);
        require!(oracle_ai.owner == &svs8_program_id, VaultError::InvalidOracle);
        require!(
            vault_ta_ai.owner == &spl_token || vault_ta_ai.owner == &spl_token_2022,
            VaultError::AssetNotFound
        );
        require!(
            user_ta_ai.owner == &spl_token || user_ta_ai.owner == &spl_token_2022,
            VaultError::AssetNotFound
        );

        // Typed deserialization
        let asset_entry = { let d = asset_entry_ai.try_borrow_data()?; AssetEntry::try_deserialize(&mut &d[..])? };
        require!(asset_entry.vault == vault_key, VaultError::InvalidOracle);

        let oracle = { let d = oracle_ai.try_borrow_data()?; OraclePrice::try_deserialize(&mut &d[..])? };
        require!(oracle.vault == vault_key, VaultError::InvalidOracle);
        require!(oracle.asset_mint == asset_entry.asset_mint, VaultError::InvalidOracle);

        let age = clock.unix_timestamp.saturating_sub(oracle.updated_at) as u64;
        require!(age <= MAX_ORACLE_STALENESS, VaultError::OracleStale);
        require!(oracle.price > 0, VaultError::InvalidOracle);

        let asset_dec = asset_entry.asset_decimals;
        let weight_bps = asset_entry.target_weight_bps;

        let vault_balance = {
            let data = vault_ta_ai.try_borrow_data()?;
            require!(data.len() >= 72, VaultError::MathOverflow);
            u64::from_le_bytes(data[64..72].try_into().map_err(|_| VaultError::MathOverflow)?)
        };

        // weighted_value = base_amount * weight_bps / 10000
        let weighted_value = (base_amount as u128)
            .checked_mul(weight_bps as u128).ok_or(VaultError::MathOverflow)?
            .checked_div(10_000u128).ok_or(VaultError::DivisionByZero)? as u64;

        // token_amount = weighted_value * PRICE_SCALE * 10^asset_dec / (price * 10^base_dec)
        let token_amount = (weighted_value as u128)
            .checked_mul(PRICE_SCALE as u128).ok_or(VaultError::MathOverflow)?
            .checked_mul(10u128.pow(asset_dec as u32)).ok_or(VaultError::MathOverflow)?
            .checked_div(oracle.price as u128).ok_or(VaultError::DivisionByZero)?
            .checked_div(10u128.pow(base_decimals as u32)).ok_or(VaultError::DivisionByZero)? as u64;

        require!(token_amount > 0, VaultError::ZeroAmount);

        let deposit_value = oracle_value_for_amount(oracle.price, token_amount, asset_dec, base_decimals)?;
        total_deposit_value = total_deposit_value.checked_add(deposit_value).ok_or(VaultError::MathOverflow)?;

        snapshots.push(AssetSnapshot {
            weight_bps,
            asset_dec,
            vault_balance,
            price: oracle.price,
            mint_key: asset_entry.asset_mint,
            vault_ta_key: vault_ta_ai.key(),
            user_ta_key: user_ta_ai.key(),
            token_amount,
            deposit_value,
            idx: i,
        });
    }

    let balances: Vec<u64> = snapshots.iter().map(|s| s.vault_balance).collect();
    let prices: Vec<u64>   = snapshots.iter().map(|s| s.price).collect();
    let decimals_vec: Vec<u8> = snapshots.iter().map(|s| s.asset_dec).collect();
    let total_value = total_portfolio_value(&balances, &prices, &decimals_vec, base_decimals)?;

    let total_shares = ctx.accounts.shares_mint.supply;
    let shares = convert_to_shares(total_deposit_value, total_value, total_shares, decimals_offset, Rounding::Floor)?;
    require!(shares >= min_shares_out, VaultError::SlippageExceeded);
    require!(shares > 0, VaultError::ZeroAmount);

    // Execute transfers using remaining_accounts only
    for i in 0..num_assets {
        let idx = snapshots[i].idx;
        let token_program_key = ctx.accounts.token_program.key();
        let ix = anchor_spl::token_interface::spl_token_2022::instruction::transfer_checked(
            &token_program_key,
            &snapshots[i].user_ta_key,
            &snapshots[i].mint_key,
            &snapshots[i].vault_ta_key,
            &ctx.accounts.user.key(),
            &[],
            snapshots[i].token_amount,
            snapshots[i].asset_dec,
        )?;
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.remaining_accounts[idx * 5 + 3].clone(), // user_ata
                ctx.remaining_accounts[idx * 5 + 4].clone(), // mint
                ctx.remaining_accounts[idx * 5 + 2].clone(), // vault_ata
                ctx.accounts.user.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
        )?;
    }

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

    emit!(DepositProportionalEvent {
        vault: vault_key,
        caller: ctx.accounts.user.key(),
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

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint @ VaultError::AssetNotFound,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub shares_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
