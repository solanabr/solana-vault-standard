use anchor_lang::prelude::*;

use crate::{
    error::TranchedVaultError,
    events::TrancheConfigUpdated,
    state::{Tranche, TranchedVault},
    waterfall::check_subordination,
};

#[derive(Accounts)]
pub struct UpdateTrancheConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ TranchedVaultError::Unauthorized,
    )]
    pub vault: Account<'info, TranchedVault>,

    #[account(
        mut,
        constraint = target_tranche.vault == vault.key() @ TranchedVaultError::TrancheVaultMismatch,
    )]
    pub target_tranche: Account<'info, Tranche>,

    pub tranche_1: Option<Account<'info, Tranche>>,
    pub tranche_2: Option<Account<'info, Tranche>>,
    pub tranche_3: Option<Account<'info, Tranche>>,
}

pub fn handler(
    ctx: Context<UpdateTrancheConfig>,
    target_yield_bps: Option<u16>,
    cap_bps: Option<u16>,
    subordination_bps: Option<u16>,
) -> Result<()> {
    if let Some(v) = target_yield_bps {
        require!(v <= 10_000, TranchedVaultError::InvalidYieldConfig);
        ctx.accounts.target_tranche.target_yield_bps = v;
    }
    if let Some(v) = cap_bps {
        require!(v > 0 && v <= 10_000, TranchedVaultError::InvalidCapConfig);
        ctx.accounts.target_tranche.cap_bps = v;
    }
    if let Some(v) = subordination_bps {
        require!(v <= 10_000, TranchedVaultError::InvalidSubordinationConfig);
        ctx.accounts.target_tranche.subordination_bps = v;
    }

    // Subordination check on post-state
    let vault = &ctx.accounts.vault;
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

    emit!(TrancheConfigUpdated {
        vault: vault.key(),
        tranche_index: tranche.index,
        target_yield_bps: tranche.target_yield_bps,
        cap_bps: tranche.cap_bps,
        subordination_bps: tranche.subordination_bps,
    });

    Ok(())
}
