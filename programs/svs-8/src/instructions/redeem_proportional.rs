use anchor_lang::prelude::*;
use anchor_spl::token_interface::{burn_checked, BurnChecked, Mint, TokenAccount, TokenInterface};
use crate::{
    constants::{MAX_ORACLE_STALENESS, MULTI_VAULT_SEED},
    error::VaultError,
    events::RedeemProportional as RedeemProportionalEvent,
    math::{convert_to_assets, total_portfolio_value, Rounding},
    state::{AssetEntry, MultiAssetVault, OraclePrice},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

/// Redeem shares proportionally across ALL basket assets.
///
/// remaining_accounts layout per asset (quintuplets):
///   [AssetEntry PDA, OraclePrice PDA, vault_ata, user_ata, mint]  x  num_assets
pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, RedeemProportional<'info>>,
    shares: u64,
    min_assets_out: u64,
) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(shares > 0, VaultError::ZeroAmount);

    let vault_key = ctx.accounts.vault.key();
    let svs8_program_id = crate::ID;
    let spl_token = anchor_spl::token::ID;
    let spl_token_2022 = anchor_spl::token_2022::ID;
    let clock = Clock::get()?;
    let total_shares = ctx.accounts.shares_mint.supply;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;

    require!(shares <= total_shares, VaultError::InsufficientShares);

    // FIX P1-2: split remaining_accounts into asset accounts and module PDAs
    let asset_len = ctx.accounts.vault.num_assets as usize * 5;
    require!(
        ctx.remaining_accounts.len() >= asset_len && asset_len > 0,
        VaultError::AssetNotFound
    );
    let (asset_accounts, _module_accounts) = ctx.remaining_accounts.split_at(asset_len);
    let num_assets = ctx.accounts.vault.num_assets as usize;

    struct AssetSnapshot {
        mint_key: Pubkey,
        asset_dec: u8,
        vault_balance: u64,
        price: u64,
        vault_ta_key: Pubkey,
        user_ta_key: Pubkey,
        token_program_key: Pubkey,
        idx: usize,
    }

    let mut snapshots: Vec<AssetSnapshot> = Vec::with_capacity(num_assets);

    for i in 0..num_assets {
        let asset_entry_ai = &asset_accounts[i * 5];
        let oracle_ai     = &asset_accounts[i * 5 + 1];
        let vault_ta_ai   = &asset_accounts[i * 5 + 2];
        let user_ta_ai    = &asset_accounts[i * 5 + 3];

        // --- Owner checks ---
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

        // Typed deserialization — no raw offsets
        let asset_entry = AssetEntry::try_deserialize(&mut &asset_entry_ai.try_borrow_data()?[..])?;
        require!(asset_entry.vault == vault_key, VaultError::InvalidOracle);

        let oracle = OraclePrice::try_deserialize(&mut &oracle_ai.try_borrow_data()?[..])?;
        require!(oracle.vault == vault_key, VaultError::InvalidOracle);
        require!(oracle.asset_mint == asset_entry.asset_mint, VaultError::InvalidOracle);

        let age = clock.unix_timestamp.saturating_sub(oracle.updated_at) as u64;
        require!(age <= MAX_ORACLE_STALENESS, VaultError::OracleStale);
        require!(oracle.price > 0, VaultError::InvalidOracle);

        // FIX P1-1: validate vault_ta matches asset_entry.asset_vault
        require!(vault_ta_ai.key() == asset_entry.asset_vault, VaultError::AssetNotFound);
        let vault_balance = crate::math::read_token_balance(vault_ta_ai)?;

        let mint_ai = &asset_accounts[i * 5 + 4];
        let token_program_key = *mint_ai.owner;
        snapshots.push(AssetSnapshot {
            mint_key: asset_entry.asset_mint,
            asset_dec: asset_entry.asset_decimals,
            vault_balance,
            price: oracle.price,
            vault_ta_key: vault_ta_ai.key(),
            user_ta_key: user_ta_ai.key(),
            token_program_key,
            idx: i,
        });
    }

    let balances: Vec<u64> = snapshots.iter().map(|s| s.vault_balance).collect();
    let prices: Vec<u64>   = snapshots.iter().map(|s| s.price).collect();
    let decimals_vec: Vec<u8> = snapshots.iter().map(|s| s.asset_dec).collect();

    let total_value = total_portfolio_value(
        &balances, &prices, &decimals_vec, ctx.accounts.vault.base_decimals,
    )?;
    let gross_value = convert_to_assets(
        shares, total_value, total_shares, ctx.accounts.vault.decimals_offset, Rounding::Floor,
    )?;

    // ===== Module Hooks (if enabled) =====
    #[cfg(feature = "modules")]
    let redeem_value = {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault_key;
        let user_key = ctx.accounts.user.key();
        module_hooks::check_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;
        module_hooks::check_share_lock(remaining, &crate::ID, &vault_key, &user_key, clock.unix_timestamp)?;
        let result = module_hooks::apply_exit_fee(remaining, &crate::ID, &vault_key, gross_value)?;
        result.net_assets
    };

    #[cfg(not(feature = "modules"))]
    let redeem_value = gross_value;

    require!(redeem_value >= min_assets_out, VaultError::SlippageExceeded);
    require!(redeem_value > 0, VaultError::ZeroAmount);

    // Transfer proportional amount of each asset to user
    let signer_seeds: &[&[&[u8]]] = &[&[MULTI_VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    for i in 0..num_assets {
        // asset_out = vault_balance * shares / total_shares (floor — favors vault)
        let asset_out = (snapshots[i].vault_balance as u128)
            .checked_mul(shares as u128).ok_or(VaultError::MathOverflow)?
            .checked_div(total_shares as u128).ok_or(VaultError::DivisionByZero)? as u64;
        if asset_out == 0 { continue; }
        // FIX P0-2: use per-asset token_program_key from snapshot
        let token_program_key = snapshots[i].token_program_key;

        let ix = anchor_spl::token_interface::spl_token_2022::instruction::transfer_checked(
            &token_program_key,
            &snapshots[i].vault_ta_key,
            &snapshots[i].mint_key,
            &snapshots[i].user_ta_key,
            &vault_key,
            &[],
            asset_out,
            snapshots[i].asset_dec,
        )?;

        let idx = snapshots[i].idx;
        // SPL transfer_checked needs: [from(vault_ata), mint, to(user_ata), authority(vault_pda)]
        // vault PDA is a program signer — Solana allows omitting it from account array
        // when using invoke_signed as the runtime infers it from signer_seeds
        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[
                asset_accounts[idx * 5 + 2].clone(), // vault_ata (from)
                asset_accounts[idx * 5 + 4].clone(), // mint
                asset_accounts[idx * 5 + 3].clone(), // user_ata (to)
                ctx.accounts.vault.to_account_info(),         // vault PDA (authority)
                ctx.remaining_accounts[idx * 5 + 4].clone(),     // token program (per-asset)
            ],
            signer_seeds,
        )?;
    }

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

    pub token_program: Interface<'info, TokenInterface>,
    pub shares_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: [AssetEntry, OraclePrice, vault_ata, user_ata] x num_assets
}
