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
    /// V5-P17: Exit fee deducted (0 when modules disabled). Enables off-chain accounting.
    pub exit_fee: u64,
}

#[event]
pub struct VaultSynced {
    pub vault: Pubkey,
    pub previous_total: u64,
    pub new_total: u64,
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

#[event]
pub struct AuthorityTransferRequested {
    pub vault: Pubkey,
    pub current_authority: Pubkey,
    pub pending_authority: Pubkey,
}

#[event]
pub struct TotalAssetsDecreased {
    pub vault: Pubkey,
    pub previous_total: u64,
    pub new_total: u64,
}

#[event]
pub struct FeesCollected {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub amount: u64,
}

#[event]
pub struct FeeRecipientUpdated {
    pub vault: Pubkey,
    pub previous_recipient: Pubkey,
    pub new_recipient: Pubkey,
}
