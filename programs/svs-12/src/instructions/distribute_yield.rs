use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    error::VaultError,
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
        has_one = manager @ VaultError::Unauthorized,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Box<Account<'info, TranchedVault>>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = asset_mint,
        associated_token::authority = manager,
        associated_token::token_program = asset_token_program,
    )]
    pub manager_asset_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault,
    )]
    pub asset_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub tranche_0: Option<Account<'info, Tranche>>,
    #[account(mut)]
    pub tranche_1: Option<Account<'info, Tranche>>,
    #[account(mut)]
    pub tranche_2: Option<Account<'info, Tranche>>,
    #[account(mut)]
    pub tranche_3: Option<Account<'info, Tranche>>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

/// Maximum yield per distribution as a fraction of total allocated assets.
/// 10_000 bps = 100% of total_allocated. This prevents a malicious or
/// compromised manager from injecting an absurdly high yield that would
/// manipulate NAV. For legitimate high-yield scenarios, multiple
/// distributions can be batched across separate transactions.
///
/// V5-P22 (fixed): The per-transaction cap is now time-bounded with a minimum cooldown
/// between distributions. This prevents a compromised manager from calling distribute_yield
/// repeatedly within a short period.
const MAX_YIELD_BPS: u64 = 10_000; // 100% of total_allocated per distribution

/// Minimum seconds between consecutive yield distributions (1 hour).
const MIN_YIELD_COOLDOWN: i64 = 3600;

pub fn handler(ctx: Context<DistributeYield>, total_yield: u64) -> Result<()> {
    require!(total_yield > 0, VaultError::ZeroAmount);

    // V5-P22 FIX: Enforce minimum cooldown between yield distributions
    let clock = Clock::get()?;
    let vault = &ctx.accounts.vault;
    require!(
        clock.unix_timestamp
            >= vault
                .last_yield_distribution
                .checked_add(MIN_YIELD_COOLDOWN)
                .ok_or(VaultError::MathOverflow)?,
        VaultError::YieldCooldownNotElapsed
    );
    let num_tranches = vault.num_tranches as usize;

    // Phase 1: Read tranche data (immutable borrows)
    let mut tranche_data: Vec<(u8, u64, u16, usize)> = Vec::new();
    let mut seen_keys: Vec<Pubkey> = Vec::new();
    macro_rules! read_tranche {
        ($field:expr, $slot:expr) => {
            if let Some(ref t) = $field {
                require!(t.vault == vault.key(), VaultError::TrancheVaultMismatch);
                require!(!seen_keys.contains(&t.key()), VaultError::DuplicateTranche);
                seen_keys.push(t.key());
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
        VaultError::WrongTrancheCount
    );

    // Sort by priority ascending (senior first)
    tranche_data.sort_by_key(|&(p, _, _, _)| p);

    let allocations: Vec<u64> = tranche_data.iter().map(|&(_, a, _, _)| a).collect();
    let target_yields: Vec<u16> = tranche_data.iter().map(|&(_, _, y, _)| y).collect();

    // Phase 2: Compute waterfall distribution (pure math, no borrows)
    let total_allocated: u64 = allocations
        .iter()
        .try_fold(0u64, |acc, &x| acc.checked_add(x))
        .ok_or(VaultError::MathOverflow)?;
    require!(total_allocated > 0, VaultError::ZeroAmount);

    // V4-P17 FIX: Cap yield to prevent NAV manipulation via absurdly high
    // distributions. Max = MAX_YIELD_BPS / 10_000 * total_allocated (i.e. 100%).
    let max_yield: u64 = (total_allocated as u128)
        .checked_mul(MAX_YIELD_BPS as u128)
        .ok_or(VaultError::MathOverflow)?
        .checked_div(10_000u128)
        .ok_or(VaultError::MathOverflow)?
        .try_into()
        .map_err(|_| VaultError::MathOverflow)?;
    require!(total_yield <= max_yield, VaultError::CapExceeded);

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
                    .ok_or(VaultError::MathOverflow)?;
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
        .ok_or(VaultError::MathOverflow)?;
    vault.last_yield_distribution = clock.unix_timestamp;

    emit!(YieldDistributed {
        vault: vault.key(),
        total_yield,
        per_tranche,
        num_tranches: vault.num_tranches,
    });

    Ok(())
}
