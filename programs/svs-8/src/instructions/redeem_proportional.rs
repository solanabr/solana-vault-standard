use crate::{
    constants::{MAX_ORACLE_STALENESS, MULTI_VAULT_SEED},
    error::VaultError,
    events::RedeemProportional as RedeemProportionalEvent,
    math::{convert_to_assets, total_portfolio_value, Rounding},
    state::{AssetEntry, MultiAssetVault, OraclePrice},
};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{burn_checked, BurnChecked, Mint, TokenAccount, TokenInterface};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

/// Redeem shares proportionally across ALL basket assets.
///
/// remaining_accounts layout per asset (sextuplets):
///   [AssetEntry PDA, OraclePrice PDA, vault_ata, user_ata, mint, token_program]  x  num_assets
///
/// Each asset carries its own token_program AccountInfo so that Token-2022
/// transfer hooks see the correct account layout (no stray accounts that
/// confuse hook programs).
///
/// V7-P6: `weights_valid` is intentionally NOT checked on redeem paths — users must always
/// be able to exit even when weights are invalid (e.g. after asset removal/rebalance).
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
    let asset_len = ctx.accounts.vault.num_assets as usize * 6;
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
        let asset_entry_ai = &asset_accounts[i * 6];
        let oracle_ai = &asset_accounts[i * 6 + 1];
        let vault_ta_ai = &asset_accounts[i * 6 + 2];
        let user_ta_ai = &asset_accounts[i * 6 + 3];

        // --- Owner checks ---
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

        // Typed deserialization — no raw offsets
        let asset_entry = AssetEntry::try_deserialize(&mut &asset_entry_ai.try_borrow_data()?[..])?;
        require!(asset_entry.vault == vault_key, VaultError::InvalidOracle);

        let oracle = OraclePrice::try_deserialize(&mut &oracle_ai.try_borrow_data()?[..])?;
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

        // FIX P1-1: validate vault_ta matches asset_entry.asset_vault
        require!(
            vault_ta_ai.key() == asset_entry.asset_vault,
            VaultError::AssetNotFound
        );
        let vault_balance = crate::math::read_token_balance(vault_ta_ai)?;

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
    let prices: Vec<u64> = snapshots.iter().map(|s| s.price).collect();
    let decimals_vec: Vec<u8> = snapshots.iter().map(|s| s.asset_dec).collect();

    let total_value = total_portfolio_value(
        &balances,
        &prices,
        &decimals_vec,
        ctx.accounts.vault.base_decimals,
    )?;
    let gross_value = convert_to_assets(
        shares,
        total_value,
        total_shares,
        ctx.accounts.vault.decimals_offset,
        Rounding::Floor,
    )?;

    // ===== Module Hooks (if enabled) =====
    #[cfg(feature = "modules")]
    let redeem_value = {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault_key;
        let user_key = ctx.accounts.user.key();
        module_hooks::check_withdrawal_access(remaining, &crate::ID, &vault_key, &user_key)?;
        module_hooks::check_share_lock(
            remaining,
            &crate::ID,
            &vault_key,
            &user_key,
            clock.unix_timestamp,
        )?;
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
        // asset_out_gross = vault_balance * shares / total_shares (floor — favors vault)
        let asset_out_gross: u64 = (snapshots[i].vault_balance as u128)
            .checked_mul(shares as u128)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(total_shares as u128)
            .ok_or(VaultError::DivisionByZero)?
            .try_into()
            .map_err(|_| VaultError::MathOverflow)?;
        if asset_out_gross == 0 {
            continue;
        }
        // Apply exit fee proportionally: asset_out = asset_out_gross * redeem_value / gross_value
        // When modules are disabled, redeem_value == gross_value so this is a no-op.
        let asset_out: u64 = (asset_out_gross as u128)
            .checked_mul(redeem_value as u128)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(gross_value as u128)
            .ok_or(VaultError::DivisionByZero)?
            .try_into()
            .map_err(|_| VaultError::MathOverflow)?;
        if asset_out == 0 {
            continue;
        }
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
        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[
                asset_accounts[idx * 6 + 2].clone(),  // vault_ata (from)
                asset_accounts[idx * 6 + 4].clone(),  // mint
                asset_accounts[idx * 6 + 3].clone(),  // user_ata (to)
                ctx.accounts.vault.to_account_info(), // vault PDA (authority)
                asset_accounts[idx * 6 + 5].clone(),  // per-asset token program
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
