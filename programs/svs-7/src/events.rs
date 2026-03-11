//! Vault events emitted on state changes.

use anchor_lang::prelude::*;

#[event]
pub struct SolVaultInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub shares_mint: Pubkey,
    pub wsol_vault: Pubkey,
    pub vault_id: u64,
    pub balance_model: u8,
}

#[event]
pub struct Deposit {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub owner: Pubkey,
    pub assets: u64,
    pub shares: u64,
    /// true if deposited via native SOL, false if via wSOL
    pub is_native: bool,
}

#[event]
pub struct Withdraw {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub receiver: Pubkey,
    pub owner: Pubkey,
    pub assets: u64,
    pub shares: u64,
    /// true if withdrawn as native SOL, false if as wSOL
    pub is_native: bool,
}

#[event]
pub struct VaultSynced {
    pub vault: Pubkey,
    pub previous_total_assets: u64,
    pub new_total_assets: u64,
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
