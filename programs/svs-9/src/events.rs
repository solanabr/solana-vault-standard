//! Events emitted by SVS-9 allocator vault.

use anchor_lang::prelude::*;

#[event]
pub struct AllocatorInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub curator: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub idle_buffer_bps: u16,
}

#[event]
pub struct ChildAdded {
    pub allocator: Pubkey,
    pub child_vault: Pubkey,
    pub child_program: Pubkey,
    pub target_weight_bps: u16,
    pub max_weight_bps: u16,
    pub index: u8,
}

#[event]
pub struct ChildRemoved {
    pub allocator: Pubkey,
    pub child_vault: Pubkey,
    pub final_shares: u64,
    pub final_assets: u64,
}

#[event]
pub struct Deposit {
    pub vault: Pubkey,
    pub depositor: Pubkey,
    pub assets: u64,
    pub shares: u64,
    pub total_assets_after: u64,
}

#[event]
pub struct Redeem {
    pub vault: Pubkey,
    pub redeemer: Pubkey,
    pub shares: u64,
    pub assets: u64,
    pub total_assets_after: u64,
}

#[event]
pub struct Allocate {
    pub allocator: Pubkey,
    pub child_vault: Pubkey,
    pub amount: u64,
    pub child_shares_received: u64,
    pub idle_after: u64,
}

#[event]
pub struct Deallocate {
    pub allocator: Pubkey,
    pub child_vault: Pubkey,
    pub shares: u64,
    pub assets_received: u64,
    pub idle_after: u64,
}

#[event]
pub struct Rebalance {
    pub allocator: Pubkey,
    pub from_child: Pubkey,
    pub to_child: Pubkey,
    pub amount: u64,
    pub from_shares: u64,
    pub to_shares: u64,
}

#[event]
pub struct Harvest {
    pub allocator: Pubkey,
    pub total_harvested: u64,
    pub num_children_harvested: u32,
}

#[event]
pub struct ChildHarvested {
    pub allocator: Pubkey,
    pub child_vault: Pubkey,
    pub shares_redeemed: u64,
    pub assets_received: u64,
    pub yield_amount: u64,
}

#[event]
pub struct WeightsUpdated {
    pub allocator: Pubkey,
    pub child_vault: Pubkey,
    pub old_target_weight_bps: u16,
    pub new_target_weight_bps: u16,
    pub old_max_weight_bps: u16,
    pub new_max_weight_bps: u16,
}

#[event]
pub struct CuratorChanged {
    pub allocator: Pubkey,
    pub old_curator: Pubkey,
    pub new_curator: Pubkey,
}

#[event]
pub struct VaultStatusChanged {
    pub vault: Pubkey,
    pub paused: bool,
    pub authority: Pubkey,
}

#[event]
pub struct TotalAssetsUpdated {
    pub vault: Pubkey,
    pub old_total: u64,
    pub new_total: u64,
    pub cache_timestamp: i64,
}
