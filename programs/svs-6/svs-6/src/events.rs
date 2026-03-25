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
pub struct DepositEvent {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub owner: Pubkey,
    pub assets: u64,
    pub shares: u64,
}

#[event]
pub struct WithdrawEvent {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub receiver: Pubkey,
    pub owner: Pubkey,
    pub assets: u64,
    pub shares: u64,
}

#[event]
pub struct DistributeYieldEvent {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub amount: u64,
    pub stream_start: i64,
    pub stream_end: i64,
}

#[event]
pub struct CheckpointEvent {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub old_base_assets: u64,
    pub new_base_assets: u64,
    pub remaining_stream: u64,
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
pub struct AccountConfigured {
    pub vault: Pubkey,
    pub user: Pubkey,
}

#[event]
pub struct PendingApplied {
    pub vault: Pubkey,
    pub user: Pubkey,
}
