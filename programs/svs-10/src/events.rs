//! Vault events emitted on state changes.

use anchor_lang::prelude::*;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub operator: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub vault_id: u64,
}

#[event]
pub struct DepositRequested {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub receiver: Pubkey,
    pub assets: u64,
}

#[event]
pub struct DepositFulfilled {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub shares: u64,
    pub assets: u64,
}

#[event]
pub struct DepositClaimed {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub receiver: Pubkey,
    pub shares: u64,
}

#[event]
pub struct DepositCancelled {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub assets_returned: u64,
}

#[event]
pub struct RedeemRequested {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub receiver: Pubkey,
    pub shares: u64,
}

#[event]
pub struct RedeemFulfilled {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub shares: u64,
    pub assets: u64,
}

#[event]
pub struct RedeemClaimed {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub receiver: Pubkey,
    pub assets: u64,
}

#[event]
pub struct RedeemCancelled {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub shares_returned: u64,
}

#[event]
pub struct OperatorSet {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub operator: Pubkey,
    pub approved: bool,
}

#[event]
pub struct VaultStatusChanged {
    pub vault: Pubkey,
    pub paused: bool,
}

#[event]
pub struct AuthorityTransferred {
    pub vault: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct VaultOperatorChanged {
    pub vault: Pubkey,
    pub old_operator: Pubkey,
    pub new_operator: Pubkey,
}
