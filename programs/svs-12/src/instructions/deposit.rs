use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, MintTo, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};
use svs_math::{convert_to_shares, Rounding};

use crate::{
    constants::{BPS_DENOMINATOR, TRANCHED_VAULT_SEED},
    error::TranchedVaultError,
    events::TrancheDeposit,
    state::{Tranche, TranchedVault},
    waterfall::check_subordination,
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ TranchedVaultError::VaultPaused,
        constraint = !vault.wiped @ TranchedVaultError::VaultWiped,
    )]
    pub vault: Account<'info, TranchedVault>,

    #[account(
        mut,
        constraint = target_tranche.vault == vault.key() @ TranchedVaultError::TrancheVaultMismatch,
    )]
    pub target_tranche: Account<'info, Tranche>,

    // Other tranches for subordination check (read-only)
    pub tranche_1: Option<Account<'info, Tranche>>,
    pub tranche_2: Option<Account<'info, Tranche>>,
    pub tranche_3: Option<Account<'info, Tranche>>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_asset_account.mint == vault.asset_mint,
        constraint = user_asset_account.owner == user.key(),
    )]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = shares_mint.key() == target_tranche.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = shares_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
}

pub fn handler(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
    require!(assets > 0, TranchedVaultError::ZeroAmount);

    let tranche = &ctx.accounts.target_tranche;
    let vault = &ctx.accounts.vault;

    // 1. Compute shares (floor rounding — vault favoring)
    let shares = convert_to_shares(
        assets,
        tranche.total_assets_allocated,
        tranche.total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )
    .map_err(|_| TranchedVaultError::MathOverflow)?;

    require!(shares > 0, TranchedVaultError::ZeroAmount);

    #[cfg(feature = "modules")]
    let shares = {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let user_key = ctx.accounts.user.key();

        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;
        module_hooks::check_deposit_caps(
            remaining,
            &crate::ID,
            &vault_key,
            &user_key,
            vault.total_assets,
            assets,
        )?;

        let result = module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    require!(
        shares >= min_shares_out,
        TranchedVaultError::SlippageExceeded
    );

    // 2. Update accounting (pre-CPI for cap + subordination checks on post-state)
    let tranche = &mut ctx.accounts.target_tranche;
    tranche.total_assets_allocated = tranche
        .total_assets_allocated
        .checked_add(assets)
        .ok_or(TranchedVaultError::MathOverflow)?;
    tranche.total_shares = tranche
        .total_shares
        .checked_add(shares)
        .ok_or(TranchedVaultError::MathOverflow)?;

    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_add(assets)
        .ok_or(TranchedVaultError::MathOverflow)?;

    // 3. Cap check on post-state
    let tranche = &ctx.accounts.target_tranche;
    let cap_numerator = (vault.total_assets as u128)
        .checked_mul(tranche.cap_bps as u128)
        .ok_or(TranchedVaultError::MathOverflow)?;
    let cap_limit = cap_numerator
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(TranchedVaultError::MathOverflow)? as u64;
    require!(
        tranche.total_assets_allocated <= cap_limit,
        TranchedVaultError::CapExceeded
    );

    // 4. Subordination check on post-state (collect all tranches)
    let mut all_allocations: Vec<(u8, u64, u16)> = Vec::new();
    let mut seen_keys: Vec<Pubkey> = Vec::new();
    let target_key = ctx.accounts.target_tranche.key();
    seen_keys.push(target_key);
    all_allocations.push((
        tranche.priority,
        tranche.total_assets_allocated,
        tranche.subordination_bps,
    ));

    for opt_tranche in [
        &ctx.accounts.tranche_1,
        &ctx.accounts.tranche_2,
        &ctx.accounts.tranche_3,
    ] {
        if let Some(t) = opt_tranche {
            require!(
                !seen_keys.contains(&t.key()),
                TranchedVaultError::DuplicateTranche
            );
            require!(
                t.vault == vault.key(),
                TranchedVaultError::TrancheVaultMismatch
            );
            seen_keys.push(t.key());
            all_allocations.push((t.priority, t.total_assets_allocated, t.subordination_bps));
        }
    }

    require!(
        all_allocations.len() == vault.num_tranches as usize,
        TranchedVaultError::WrongTrancheCount
    );

    // Sort by priority ascending (senior first)
    all_allocations.sort_by_key(|&(p, _, _)| p);
    let sorted_allocs: Vec<u64> = all_allocations.iter().map(|&(_, a, _)| a).collect();
    let sorted_sub_bps: Vec<u16> = all_allocations.iter().map(|&(_, _, s)| s).collect();
    check_subordination(&sorted_allocs, &sorted_sub_bps, vault.total_assets)?;

    // 5. CPIs: transfer assets in, mint shares out
    let tranche_index = ctx.accounts.target_tranche.index;
    let tranche_priority = ctx.accounts.target_tranche.priority;

    transfer_checked(
        CpiContext::new(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_asset_account.to_account_info(),
                to: ctx.accounts.asset_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        TRANCHED_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    token_2022::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares,
    )?;

    ctx.accounts.asset_vault.reload()?;
    ctx.accounts.shares_mint.reload()?;

    // 6. Emit event
    emit!(TrancheDeposit {
        vault: ctx.accounts.vault.key(),
        tranche_index,
        tranche_priority,
        investor: ctx.accounts.user.key(),
        assets,
        shares,
    });

    Ok(())
}
