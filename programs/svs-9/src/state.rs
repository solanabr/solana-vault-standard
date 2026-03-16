//! SVS-9 Allocator Vault state account definitions.

use anchor_lang::prelude::*;
use crate::constants::{ALLOCATOR_SEED, CHILD_ALLOCATION_SEED, MAX_CHILDREN};

#[account]
pub struct AllocatorVault {
    pub authority: Pubkey,
    pub curator: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub idle_vault: Pubkey,
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub vault_id: u64,
    pub num_children: u8,
    pub idle_buffer_bps: u16,
    pub _reserved: [u8; 64],
}

impl AllocatorVault {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 32 + 1 + 1 + 1 + 8 + 1 + 2 + 64;
    pub const SEED_PREFIX: &'static [u8] = ALLOCATOR_SEED;
}

#[account]
pub struct ChildAllocation {
    pub allocator_vault: Pubkey,
    pub child_vault: Pubkey,
    pub child_program: Pubkey,
    pub child_shares_account: Pubkey,
    pub target_weight_bps: u16,
    pub max_weight_bps: u16,
    pub deposited_assets: u64,
    pub index: u8,
    pub enabled: bool,
    pub bump: u8,
}

impl ChildAllocation {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 2 + 2 + 8 + 1 + 1 + 1;
    pub const SEED_PREFIX: &'static [u8] = CHILD_ALLOCATION_SEED;
}
