use anchor_lang::prelude::*;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub asset_mint: Pubkey,
    pub waterfall_mode: u8,
    pub vault_id: u64,
}

#[event]
pub struct TrancheAdded {
    pub vault: Pubkey,
    pub index: u8,
    pub priority: u8,
    pub subordination_bps: u16,
    pub target_yield_bps: u16,
    pub cap_bps: u16,
}

#[event]
pub struct TrancheDeposit {
    pub vault: Pubkey,
    pub tranche_index: u8,
    pub tranche_priority: u8,
    pub investor: Pubkey,
    pub assets: u64,
    pub shares: u64,
}

#[event]
pub struct TrancheRedeem {
    pub vault: Pubkey,
    pub tranche_index: u8,
    pub tranche_priority: u8,
    pub investor: Pubkey,
    pub shares: u64,
    pub assets: u64,
}

#[event]
pub struct YieldDistributed {
    pub vault: Pubkey,
    pub total_yield: u64,
    pub per_tranche: [u64; 4],
    pub num_tranches: u8,
}

#[event]
pub struct LossRecorded {
    pub vault: Pubkey,
    pub total_loss: u64,
    pub per_tranche: [u64; 4],
    pub num_tranches: u8,
}

#[event]
pub struct TrancheRebalanced {
    pub vault: Pubkey,
    pub from_index: u8,
    pub to_index: u8,
    pub amount: u64,
}

#[event]
pub struct TrancheConfigUpdated {
    pub vault: Pubkey,
    pub tranche_index: u8,
    pub target_yield_bps: u16,
    pub cap_bps: u16,
    pub subordination_bps: u16,
}

#[event]
pub struct VaultPaused {
    pub vault: Pubkey,
}

#[event]
pub struct VaultUnpaused {
    pub vault: Pubkey,
}

#[event]
pub struct AuthorityTransferred {
    pub vault: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct ManagerChanged {
    pub vault: Pubkey,
    pub old_manager: Pubkey,
    pub new_manager: Pubkey,
}
