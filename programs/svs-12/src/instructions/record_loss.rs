//! Record loss instruction.
//!
//! Decreases total_assets and tranche allocations without moving tokens out of
//! asset_vault. The "stranded" tokens (asset_vault.amount > vault.total_assets)
//! represent written-off collateral still held on-chain. This is intentional:
//! the underlying credit may partially recover later, at which point the manager
//! calls distribute_yield to re-allocate recovered value through the waterfall.
//!
//! A full wipe (total_assets reaches 0) sets `vault.wiped = true`, permanently
//! blocking new deposits. Existing shareholders can still redeem after recovery
//! via distribute_yield, but the vault does not reopen for new capital.

use anchor_lang::prelude::*;

use crate::{
    error::TranchedVaultError,
    events::LossRecorded,
    state::{Tranche, TranchedVault},
    waterfall::absorb_losses,
};

#[derive(Accounts)]
pub struct RecordLoss<'info> {
    pub manager: Signer<'info>,

    #[account(
        mut,
        has_one = manager @ TranchedVaultError::Unauthorized,
        constraint = !vault.paused @ TranchedVaultError::VaultPaused,
    )]
    pub vault: Account<'info, TranchedVault>,

    #[account(mut)]
    pub tranche_0: Option<Account<'info, Tranche>>,
    #[account(mut)]
    pub tranche_1: Option<Account<'info, Tranche>>,
    #[account(mut)]
    pub tranche_2: Option<Account<'info, Tranche>>,
    #[account(mut)]
    pub tranche_3: Option<Account<'info, Tranche>>,
}

pub fn handler(ctx: Context<RecordLoss>, total_loss: u64) -> Result<()> {
    require!(total_loss > 0, TranchedVaultError::ZeroAmount);

    let vault = &ctx.accounts.vault;
    require!(
        total_loss <= vault.total_assets,
        TranchedVaultError::TotalLoss
    );

    let num_tranches = vault.num_tranches as usize;

    // Phase 1: Read tranche data (immutable borrows)
    let mut tranche_info: Vec<(u8, u64, usize)> = Vec::new();
    macro_rules! read_tranche {
        ($field:expr, $slot:expr) => {
            if let Some(ref t) = $field {
                require!(
                    t.vault == vault.key(),
                    TranchedVaultError::TrancheVaultMismatch
                );
                tranche_info.push((t.priority, t.total_assets_allocated, $slot));
            }
        };
    }
    read_tranche!(ctx.accounts.tranche_0, 0);
    read_tranche!(ctx.accounts.tranche_1, 1);
    read_tranche!(ctx.accounts.tranche_2, 2);
    read_tranche!(ctx.accounts.tranche_3, 3);
    require!(
        tranche_info.len() == num_tranches,
        TranchedVaultError::WrongTrancheCount
    );

    // Sort by priority ascending (senior first — absorb_losses iterates in reverse)
    tranche_info.sort_by_key(|&(p, _, _)| p);
    let mut allocations: Vec<u64> = tranche_info.iter().map(|&(_, a, _)| a).collect();

    // Phase 2: Compute loss absorption (pure math)
    let absorbed = absorb_losses(total_loss, &mut allocations)?;

    // Phase 3: Write back (mutable borrows)
    let mut per_slot_alloc = [0u64; 4];
    let mut per_tranche = [0u64; 4];
    for (sorted_idx, &(_, _, slot_idx)) in tranche_info.iter().enumerate() {
        per_slot_alloc[slot_idx] = allocations[sorted_idx];
        per_tranche[sorted_idx] = absorbed[sorted_idx];
    }

    macro_rules! write_tranche_loss {
        ($field:expr, $slot:expr) => {
            if let Some(ref mut t) = $field {
                t.total_assets_allocated = per_slot_alloc[$slot];
            }
        };
    }
    write_tranche_loss!(ctx.accounts.tranche_0, 0);
    write_tranche_loss!(ctx.accounts.tranche_1, 1);
    write_tranche_loss!(ctx.accounts.tranche_2, 2);
    write_tranche_loss!(ctx.accounts.tranche_3, 3);

    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_sub(total_loss)
        .ok_or(TranchedVaultError::MathOverflow)?;

    if vault.total_assets == 0 {
        vault.wiped = true;
    }

    emit!(LossRecorded {
        vault: vault.key(),
        total_loss,
        per_tranche,
        num_tranches: vault.num_tranches,
    });

    Ok(())
}
