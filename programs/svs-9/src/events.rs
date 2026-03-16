//! SVS-9 events.
use anchor_lang::prelude::*;

#[event]
pub struct AllocatorInitialized {
    pub vault: Pubkey, pub authority: Pubkey, pub curator: Pubkey,
    pub asset_mint: Pubkey, pub shares_mint: Pubkey, pub idle_vault: Pubkey,
    pub vault_id: u64, pub idle_buffer_bps: u16,
}
#[event]
pub struct ChildAdded {
    pub allocator: Pubkey, pub child_vault: Pubkey, pub child_program: Pubkey,
    pub target_weight_bps: u16, pub max_weight_bps: u16, pub index: u8,
}
#[event]
pub struct ChildRemoved { pub allocator: Pubkey, pub child_vault: Pubkey, pub index: u8 }
#[event]
pub struct ChildWeightsUpdated {
    pub allocator: Pubkey, pub child_vault: Pubkey,
    pub old_target_bps: u16, pub new_target_bps: u16,
    pub old_max_bps: u16, pub new_max_bps: u16,
}
#[event]
pub struct ChildToggled { pub allocator: Pubkey, pub child_vault: Pubkey, pub enabled: bool }
#[event]
pub struct Deposit { pub vault: Pubkey, pub caller: Pubkey, pub owner: Pubkey, pub assets: u64, pub shares: u64 }
#[event]
pub struct Redeem { pub vault: Pubkey, pub caller: Pubkey, pub owner: Pubkey, pub shares: u64, pub assets: u64 }
#[event]
pub struct Allocate { pub allocator: Pubkey, pub child_vault: Pubkey, pub assets_deployed: u64, pub child_shares_received: u64 }
#[event]
pub struct Deallocate { pub allocator: Pubkey, pub child_vault: Pubkey, pub shares_redeemed: u64, pub assets_received: u64 }
#[event]
pub struct AllocatorStatusChanged { pub vault: Pubkey, pub paused: bool }
#[event]
pub struct AuthorityTransferred { pub vault: Pubkey, pub previous_authority: Pubkey, pub new_authority: Pubkey }
#[event]
pub struct CuratorChanged { pub vault: Pubkey, pub previous_curator: Pubkey, pub new_curator: Pubkey }
#[event]
pub struct IdleBufferUpdated { pub vault: Pubkey, pub old_bps: u16, pub new_bps: u16 }
