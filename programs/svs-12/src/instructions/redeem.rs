use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, Burn, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};
use svs_math::{convert_to_assets, Rounding};

use crate::{
    constants::TRANCHED_VAULT_SEED,
    error::TranchedVaultError,
    events::TrancheRedeem,
    state::{Tranche, TranchedVault},
    waterfall::check_subordination,
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ TranchedVaultError::VaultPaused,
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

pub fn handler(ctx: Context<Redeem>, shares: u64, min_assets_out: u64) -> Result<()> {
    require!(shares > 0, TranchedVaultError::ZeroAmount);
    require!(
        ctx.accounts.user_shares_account.amount >= shares,
        TranchedVaultError::InsufficientShares
    );

    let tranche = &ctx.accounts.target_tranche;
    let vault = &ctx.accounts.vault;

    #[cfg(feature = "modules")]
    {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let user_key = ctx.accounts.user.key();

        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;

        let current_timestamp = Clock::get()?.unix_timestamp;
        module_hooks::check_share_lock(
            remaining,
            &crate::ID,
            &vault_key,
            &user_key,
            current_timestamp,
        )?;
    }

    let assets = convert_to_assets(
        shares,
        tranche.total_assets_allocated,
        tranche.total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )
    .map_err(|_| TranchedVaultError::MathOverflow)?;

    #[cfg(feature = "modules")]
    let assets = {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let result = module_hooks::apply_exit_fee(remaining, &crate::ID, &vault_key, assets)?;
        result.net_assets
    };

    require!(
        assets >= min_assets_out,
        TranchedVaultError::SlippageExceeded
    );
    require!(
        ctx.accounts.asset_vault.amount >= assets,
        TranchedVaultError::InsufficientLiquidity
    );

    // 2. Update accounting
    let tranche = &mut ctx.accounts.target_tranche;
    tranche.total_assets_allocated = tranche
        .total_assets_allocated
        .checked_sub(assets)
        .ok_or(TranchedVaultError::MathOverflow)?;
    tranche.total_shares = tranche
        .total_shares
        .checked_sub(shares)
        .ok_or(TranchedVaultError::MathOverflow)?;

    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_sub(assets)
        .ok_or(TranchedVaultError::MathOverflow)?;

    // 3. Subordination check on post-state
    let tranche = &ctx.accounts.target_tranche;
    let mut all_allocations: Vec<(u8, u64, u16)> = Vec::new();
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
                t.vault == vault.key(),
                TranchedVaultError::TrancheVaultMismatch
            );
            all_allocations.push((t.priority, t.total_assets_allocated, t.subordination_bps));
        }
    }

    require!(
        all_allocations.len() == vault.num_tranches as usize,
        TranchedVaultError::WrongTrancheCount
    );

    all_allocations.sort_by_key(|&(p, _, _)| p);
    let sorted_allocs: Vec<u64> = all_allocations.iter().map(|&(_, a, _)| a).collect();
    let sorted_sub_bps: Vec<u16> = all_allocations.iter().map(|&(_, _, s)| s).collect();
    check_subordination(&sorted_allocs, &sorted_sub_bps, vault.total_assets)?;

    // 4. CPIs: burn shares, transfer assets
    let tranche_index = ctx.accounts.target_tranche.index;
    let tranche_priority = ctx.accounts.target_tranche.priority;

    token_2022::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.to_account_info(),
            Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
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

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.asset_vault.to_account_info(),
                to: ctx.accounts.user_asset_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    ctx.accounts.asset_vault.reload()?;
    ctx.accounts.shares_mint.reload()?;

    // 5. Emit event
    emit!(TrancheRedeem {
        vault: ctx.accounts.vault.key(),
        tranche_index,
        tranche_priority,
        investor: ctx.accounts.user.key(),
        shares,
        assets,
    });

    Ok(())
}
