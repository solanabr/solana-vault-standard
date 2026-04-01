use anchor_lang::prelude::*;

use crate::{
    error::VaultError,
    events::TrancheRebalanced,
    state::{Tranche, TranchedVault},
    waterfall::check_subordination,
};

#[derive(Accounts)]
pub struct RebalanceTranches<'info> {
    pub manager: Signer<'info>,

    #[account(
        has_one = manager @ VaultError::Unauthorized,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, TranchedVault>,

    #[account(
        mut,
        has_one = vault @ VaultError::TrancheVaultMismatch,
    )]
    pub from_tranche: Account<'info, Tranche>,

    #[account(
        mut,
        has_one = vault @ VaultError::TrancheVaultMismatch,
    )]
    pub to_tranche: Account<'info, Tranche>,

    // Other tranches for subordination check
    pub other_tranche_0: Option<Account<'info, Tranche>>,
    pub other_tranche_1: Option<Account<'info, Tranche>>,
}

pub fn handler(ctx: Context<RebalanceTranches>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    require!(!ctx.accounts.vault.wiped, VaultError::VaultWiped);
    require!(
        ctx.accounts.from_tranche.total_assets_allocated >= amount,
        VaultError::InsufficientAllocation
    );

    // Update accounting
    ctx.accounts.from_tranche.total_assets_allocated = ctx
        .accounts
        .from_tranche
        .total_assets_allocated
        .checked_sub(amount)
        .ok_or(VaultError::MathOverflow)?;

    ctx.accounts.to_tranche.total_assets_allocated = ctx
        .accounts
        .to_tranche
        .total_assets_allocated
        .checked_add(amount)
        .ok_or(VaultError::MathOverflow)?;

    // Subordination check
    let vault = &ctx.accounts.vault;
    let mut all_allocations: Vec<(u8, u64, u16)> = Vec::new();
    let mut seen_keys: Vec<Pubkey> = Vec::new();
    seen_keys.push(ctx.accounts.from_tranche.key());
    seen_keys.push(ctx.accounts.to_tranche.key());
    all_allocations.push((
        ctx.accounts.from_tranche.priority,
        ctx.accounts.from_tranche.total_assets_allocated,
        ctx.accounts.from_tranche.subordination_bps,
    ));
    all_allocations.push((
        ctx.accounts.to_tranche.priority,
        ctx.accounts.to_tranche.total_assets_allocated,
        ctx.accounts.to_tranche.subordination_bps,
    ));

    for opt_tranche in [&ctx.accounts.other_tranche_0, &ctx.accounts.other_tranche_1] {
        if let Some(t) = opt_tranche {
            require!(!seen_keys.contains(&t.key()), VaultError::DuplicateTranche);
            require!(t.vault == vault.key(), VaultError::TrancheVaultMismatch);
            seen_keys.push(t.key());
            all_allocations.push((t.priority, t.total_assets_allocated, t.subordination_bps));
        }
    }

    require!(
        all_allocations.len() == vault.num_tranches as usize,
        VaultError::WrongTrancheCount
    );

    all_allocations.sort_by_key(|&(p, _, _)| p);
    let sorted_allocs: Vec<u64> = all_allocations.iter().map(|&(_, a, _)| a).collect();
    let sorted_sub_bps: Vec<u16> = all_allocations.iter().map(|&(_, _, s)| s).collect();
    check_subordination(&sorted_allocs, &sorted_sub_bps, vault.total_assets)?;

    let to_tranche = &ctx.accounts.to_tranche;
    if vault.total_assets > 0 {
        let cap_limit = (vault.total_assets as u128)
            .checked_mul(to_tranche.cap_bps as u128)
            .and_then(|v| v.checked_div(crate::constants::BPS_DENOMINATOR as u128))
            .ok_or(VaultError::MathOverflow)? as u64;
        require!(
            to_tranche.total_assets_allocated <= cap_limit,
            VaultError::CapExceeded
        );
    }

    let from_index = ctx.accounts.from_tranche.index;
    let to_index = ctx.accounts.to_tranche.index;

    emit!(TrancheRebalanced {
        vault: vault.key(),
        from_index,
        to_index,
        amount,
    });

    Ok(())
}
