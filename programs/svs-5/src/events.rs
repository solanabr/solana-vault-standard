//! Vault events emitted on state changes.

use anchor_lang::prelude::*;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub vault_id: u64,
}

#[event]
pub struct Deposit {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub owner: Pubkey,
    pub assets: u64,
    pub shares: u64,
}

#[event]
pub struct Withdraw {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub receiver: Pubkey,
    pub owner: Pubkey,
    pub assets: u64,
    pub shares: u64,
}

#[event]
pub struct VaultStatusChanged {
    pub vault: Pubkey,
    pub paused: bool,
}

#[event]
pub struct AuthorityTransferred {
    pub vault: Pubkey,
    pub previous_authority: Pubkey,
    pub new_authority: Pubkey,
}

/// Emitted when a new yield stream is started via distribute_yield.
#[event]
pub struct YieldStreamStarted {
    pub vault: Pubkey,
    pub amount: u64,
    pub duration: i64,
    pub start: i64,
    pub end: i64,
}

/// Emitted when accrued yield is finalized into base_assets via checkpoint.
#[event]
pub struct CheckpointEvent {
    pub vault: Pubkey,
    pub accrued: u64,
    pub new_base_assets: u64,
    pub timestamp: i64,
}
