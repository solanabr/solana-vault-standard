//! SVS-7 events for indexers and UI.
use anchor_lang::prelude::*;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub shares_mint: Pubkey,
    pub wsol_vault: Pubkey,
    pub vault_id: u64,
    pub is_stored_model: bool,
}

#[event]
pub struct DepositSolEvent {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub lamports: u64,
    pub shares: u64,
}

#[event]
pub struct DepositWsolEvent {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub lamports: u64,
    pub shares: u64,
}

#[event]
pub struct MintSharesEvent {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub lamports: u64,
    pub shares: u64,
}

#[event]
pub struct WithdrawSolEvent {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub lamports: u64,
    pub shares: u64,
}

#[event]
pub struct WithdrawWsolEvent {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub lamports: u64,
    pub shares: u64,
}

#[event]
pub struct RedeemSolEvent {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub lamports: u64,
    pub shares: u64,
}

#[event]
pub struct RedeemWsolEvent {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub lamports: u64,
    pub shares: u64,
}

#[event]
pub struct VaultSynced {
    pub vault: Pubkey,
    pub total_assets: u64,
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
