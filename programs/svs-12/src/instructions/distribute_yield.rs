use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    error::TranchedVaultError,
    events::YieldDistributed,
    state::{Tranche, TranchedVault, WaterfallMode},
    waterfall::{distribute_yield_prorata, distribute_yield_sequential},
};

#[derive(Accounts)]
pub struct DistributeYield<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        mut,
        has_one = manager @ TranchedVaultError::Unauthorized,
        constraint = !vault.paused @ TranchedVaultError::VaultPaused,
    )]
    pub vault: Account<'info, TranchedVault>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = manager_asset_account.mint == vault.asset_mint,
        constraint = manager_asset_account.owner == manager.key(),
    )]
    pub manager_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub tranche_0: Option<Account<'info, Tranche>>,
    #[account(mut)]
    pub tranche_1: Option<Account<'info, Tranche>>,
    #[account(mut)]
    pub tranche_2: Option<Account<'info, Tranche>>,
    #[account(mut)]
    pub tranche_3: Option<Account<'info, Tranche>>,

    pub asset_token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<DistributeYield>, total_yield: u64) -> Result<()> {
    require!(total_yield > 0, TranchedVaultError::ZeroAmount);

    let vault = &ctx.accounts.vault;
    let num_tranches = vault.num_tranches as usize;

    // Phase 1: Read tranche data (immutable borrows)
    let mut tranche_data: Vec<(u8, u64, u16, usize)> = Vec::new();
    macro_rules! read_tranche {
        ($field:expr, $slot:expr) => {
            if let Some(ref t) = $field {
                require!(
                    t.vault == vault.key(),
                    TranchedVaultError::TrancheVaultMismatch
                );
                tranche_data.push((
                    t.priority,
                    t.total_assets_allocated,
                    t.target_yield_bps,
                    $slot,
                ));
            }
        };
    }
    read_tranche!(ctx.accounts.tranche_0, 0);
    read_tranche!(ctx.accounts.tranche_1, 1);
    read_tranche!(ctx.accounts.tranche_2, 2);
    read_tranche!(ctx.accounts.tranche_3, 3);
    require!(
        tranche_data.len() == num_tranches,
        TranchedVaultError::WrongTrancheCount
    );

    // Sort by priority ascending (senior first)
    tranche_data.sort_by_key(|&(p, _, _, _)| p);

    let allocations: Vec<u64> = tranche_data.iter().map(|&(_, a, _, _)| a).collect();
    let target_yields: Vec<u16> = tranche_data.iter().map(|&(_, _, y, _)| y).collect();

    // Phase 2: Compute waterfall distribution (pure math, no borrows)
    let distribution = match vault.waterfall_mode {
        WaterfallMode::Sequential => {
            distribute_yield_sequential(total_yield, &allocations, &target_yields)?
        }
        WaterfallMode::ProRataYieldSequentialLoss => {
            distribute_yield_prorata(total_yield, &allocations)?
        }
    };

    // Phase 3: CPI — transfer yield tokens from manager → asset_vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.manager_asset_account.to_account_info(),
                to: ctx.accounts.asset_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.manager.to_account_info(),
            },
        ),
        total_yield,
        ctx.accounts.asset_mint.decimals,
    )?;

    ctx.accounts.asset_vault.reload()?;

    // Phase 4: Write back (mutable borrows, no overlap with Phase 1)
    let mut per_slot_dist = [0u64; 4];
    let mut per_tranche = [0u64; 4];
    for (sorted_idx, &(_, _, _, slot_idx)) in tranche_data.iter().enumerate() {
        per_slot_dist[slot_idx] = distribution[sorted_idx];
        per_tranche[sorted_idx] = distribution[sorted_idx];
    }

    macro_rules! write_tranche {
        ($field:expr, $slot:expr) => {
            if let Some(ref mut t) = $field {
                t.total_assets_allocated = t
                    .total_assets_allocated
                    .checked_add(per_slot_dist[$slot])
                    .ok_or(TranchedVaultError::MathOverflow)?;
            }
        };
    }
    write_tranche!(ctx.accounts.tranche_0, 0);
    write_tranche!(ctx.accounts.tranche_1, 1);
    write_tranche!(ctx.accounts.tranche_2, 2);
    write_tranche!(ctx.accounts.tranche_3, 3);

    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_add(total_yield)
        .ok_or(TranchedVaultError::MathOverflow)?;

    emit!(YieldDistributed {
        vault: vault.key(),
        total_yield,
        per_tranche,
        num_tranches: vault.num_tranches,
    });

    Ok(())
}
