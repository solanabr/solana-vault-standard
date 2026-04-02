use crate::{
    constants::{MAX_ORACLE_STALENESS, MIN_DEPOSIT, MULTI_VAULT_SEED, PRICE_SCALE},
    error::VaultError,
    events::DepositProportional as DepositProportionalEvent,
    math::{convert_to_shares, oracle_value_for_amount, total_portfolio_value, Rounding},
    state::{AssetEntry, MultiAssetVault, OraclePrice},
};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    mint_to_checked, Mint, MintToChecked, TokenAccount, TokenInterface,
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

/// Atomic proportional deposit across ALL basket assets.
///
/// remaining_accounts layout per asset (sextuplets):
///   [AssetEntry PDA, OraclePrice PDA, vault_ata, user_ata, mint, token_program]  x  num_assets
///
/// Each asset carries its own token_program AccountInfo so that Token-2022
/// transfer hooks see the correct account layout (no stray accounts that
/// confuse hook programs).
pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DepositProportional<'info>>,
    base_amount: u64,
    min_shares_out: u64,
) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(
        ctx.accounts.vault.weights_valid,
        VaultError::WeightsNotValid
    );
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

    // FIX P1-2: split remaining_accounts into asset accounts and module PDAs
    let asset_len = ctx.accounts.vault.num_assets as usize * 6;
    require!(
        ctx.remaining_accounts.len() >= asset_len && asset_len > 0,
        VaultError::AssetNotFound
    );
    let (asset_accounts, _module_accounts) = ctx.remaining_accounts.split_at(asset_len);
    let num_assets = ctx.accounts.vault.num_assets as usize;

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
        token_program_key: Pubkey,
        idx: usize,
    }

    let mut snapshots: Vec<AssetSnapshot> = Vec::with_capacity(num_assets);
    let mut total_deposit_value: u64 = 0;

    for i in 0..num_assets {
        let asset_entry_ai = &asset_accounts[i * 6];
        let oracle_ai = &asset_accounts[i * 6 + 1];
        let vault_ta_ai = &asset_accounts[i * 6 + 2];
        let user_ta_ai = &asset_accounts[i * 6 + 3];

        // Owner checks
        require!(
            asset_entry_ai.owner == &svs8_program_id,
            VaultError::InvalidOracle
        );
        require!(
            oracle_ai.owner == &svs8_program_id,
            VaultError::InvalidOracle
        );
        require!(
            vault_ta_ai.owner == &spl_token || vault_ta_ai.owner == &spl_token_2022,
            VaultError::AssetNotFound
        );
        require!(
            user_ta_ai.owner == &spl_token || user_ta_ai.owner == &spl_token_2022,
            VaultError::AssetNotFound
        );

        // Typed deserialization
        let asset_entry = {
            let d = asset_entry_ai.try_borrow_data()?;
            AssetEntry::try_deserialize(&mut &d[..])?
        };
        require!(asset_entry.vault == vault_key, VaultError::InvalidOracle);
        // FIX P0: validate vault_ta matches asset_entry.asset_vault
        require!(
            vault_ta_ai.key() == asset_entry.asset_vault,
            VaultError::AssetNotFound
        );

        let oracle = {
            let d = oracle_ai.try_borrow_data()?;
            OraclePrice::try_deserialize(&mut &d[..])?
        };
        require!(oracle.vault == vault_key, VaultError::InvalidOracle);
        require!(
            oracle.asset_mint == asset_entry.asset_mint,
            VaultError::InvalidOracle
        );
        // V4-P18 FIX: Validate oracle account key matches asset_entry.oracle
        require!(
            oracle_ai.key() == asset_entry.oracle,
            VaultError::InvalidOracle
        );

        // V4-P21: Reject future oracle timestamps — saturating_sub would treat them as fresh
        require!(
            oracle.updated_at <= clock.unix_timestamp,
            VaultError::InvalidOracle
        );
        let age = clock.unix_timestamp.saturating_sub(oracle.updated_at) as u64;
        require!(age <= MAX_ORACLE_STALENESS, VaultError::OracleStale);
        require!(oracle.price > 0, VaultError::InvalidOracle);

        let asset_dec = asset_entry.asset_decimals;
        let weight_bps = asset_entry.target_weight_bps;

        let vault_balance = crate::math::read_token_balance(vault_ta_ai)?;

        // weighted_value = base_amount * weight_bps / 10000
        let weighted_value: u64 = (base_amount as u128)
            .checked_mul(weight_bps as u128)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(10_000u128)
            .ok_or(VaultError::DivisionByZero)?
            .try_into()
            .map_err(|_| VaultError::MathOverflow)?;

        // token_amount = weighted_value * PRICE_SCALE * 10^asset_dec / (price * 10^base_dec)
        let token_amount: u64 = (weighted_value as u128)
            .checked_mul(PRICE_SCALE as u128)
            .ok_or(VaultError::MathOverflow)?
            .checked_mul(10u128.pow(asset_dec as u32))
            .ok_or(VaultError::MathOverflow)?
            .checked_div(oracle.price as u128)
            .ok_or(VaultError::DivisionByZero)?
            .checked_div(10u128.pow(base_decimals as u32))
            .ok_or(VaultError::DivisionByZero)?
            .try_into()
            .map_err(|_| VaultError::MathOverflow)?;

        require!(token_amount > 0, VaultError::ZeroAmount);

        let deposit_value =
            oracle_value_for_amount(oracle.price, token_amount, asset_dec, base_decimals)?;
        total_deposit_value = total_deposit_value
            .checked_add(deposit_value)
            .ok_or(VaultError::MathOverflow)?;

        let mint_ai = &asset_accounts[i * 6 + 4];
        let token_program_ai = &asset_accounts[i * 6 + 5];
        // Validate mint matches asset_entry to ensure token_program_key is trustworthy
        require!(
            mint_ai.key() == asset_entry.asset_mint,
            VaultError::AssetNotFound
        );
        let token_program_key = *mint_ai.owner;
        // Validate the per-asset token program: must be executable and match mint owner
        require!(
            token_program_ai.key() == token_program_key,
            VaultError::AssetNotFound
        );
        require!(token_program_ai.executable, VaultError::AssetNotFound);
        // Validate user_ta mint matches asset_entry.asset_mint.
        // SPL Token / Token-2022 layout: bytes 0..32 = mint pubkey (see math::read_token_balance docs).
        {
            let user_ta_data = user_ta_ai.try_borrow_data()?;
            require!(user_ta_data.len() >= 32, VaultError::MathOverflow);
            let user_ta_mint =
                Pubkey::try_from(&user_ta_data[0..32]).map_err(|_| VaultError::AssetNotFound)?;
            require!(
                user_ta_mint == asset_entry.asset_mint,
                VaultError::AssetNotFound
            );
        }
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
            token_program_key,
            idx: i,
        });
    }

    // FIX P2-2: validate weights sum to exactly 10,000 bps before accepting deposit
    // V6-P5: Use checked arithmetic to prevent theoretical overflow for large asset counts
    let total_weight: u32 = snapshots
        .iter()
        .try_fold(0u32, |acc, s| acc.checked_add(s.weight_bps as u32))
        .ok_or(VaultError::MathOverflow)?;
    require!(total_weight == 10_000, VaultError::InvalidWeight);

    let balances: Vec<u64> = snapshots.iter().map(|s| s.vault_balance).collect();
    let prices: Vec<u64> = snapshots.iter().map(|s| s.price).collect();
    let decimals_vec: Vec<u8> = snapshots.iter().map(|s| s.asset_dec).collect();
    let total_value = total_portfolio_value(&balances, &prices, &decimals_vec, base_decimals)?;

    let total_shares = ctx.accounts.shares_mint.supply;
    // ===== Module Hooks (if enabled) =====
    #[cfg(feature = "modules")]
    let net_shares = {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault_key;
        let user_key = ctx.accounts.user.key();

        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;
        module_hooks::check_deposit_caps(
            remaining,
            &crate::ID,
            &vault_key,
            &user_key,
            total_value,
            total_deposit_value,
        )?;

        let shares = convert_to_shares(
            total_deposit_value,
            total_value,
            total_shares,
            decimals_offset,
            Rounding::Floor,
        )?;
        let result = module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    let net_shares = convert_to_shares(
        total_deposit_value,
        total_value,
        total_shares,
        decimals_offset,
        Rounding::Floor,
    )?;

    require!(net_shares >= min_shares_out, VaultError::SlippageExceeded);
    require!(net_shares > 0, VaultError::ZeroAmount);

    // Execute transfers using remaining_accounts only
    for i in 0..num_assets {
        let idx = snapshots[i].idx;
        let token_program_key = snapshots[i].token_program_key;
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
                asset_accounts[idx * 6 + 3].clone(), // user_ata (from)
                asset_accounts[idx * 6 + 4].clone(), // mint
                asset_accounts[idx * 6 + 2].clone(), // vault_ata (to)
                ctx.accounts.user.to_account_info(), // authority
                asset_accounts[idx * 6 + 5].clone(), // per-asset token program
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
        net_shares,
        9,
    )?;

    // Update per-user cumulative deposit tracking (if caps module is active)
    #[cfg(feature = "modules")]
    module_hooks::update_user_deposit(
        ctx.remaining_accounts,
        &crate::ID,
        &vault_key,
        &ctx.accounts.user.key(),
        total_deposit_value,
    )?;

    // V4-P19 FIX: Emit actual_deposit_value (sum of per-asset oracle valuations
    // of rounded token amounts) alongside the requested base_amount.
    emit!(DepositProportionalEvent {
        vault: vault_key,
        caller: ctx.accounts.user.key(),
        base_amount,
        shares: net_shares,
        total_value: total_deposit_value,
        actual_deposit_value: total_deposit_value,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct DepositProportional<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// V9-P9: Add PDA seed validation for defense-in-depth consistency with admin instructions.
    #[account(
        mut,
        seeds = [crate::constants::MULTI_VAULT_SEED, vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint @ VaultError::AssetNotFound,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = shares_mint,
        associated_token::authority = user,
        associated_token::token_program = shares_token_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// Token program for shares operations only. Per-asset token programs are
    /// passed via remaining_accounts (sextuplet index 5) so each asset uses
    /// the correct program, avoiding Token-2022 transfer hook account conflicts.
    pub shares_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
