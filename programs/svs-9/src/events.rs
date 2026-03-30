use anchor_lang::prelude::*;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub asset_mint: Pubkey,
    pub authority: Pubkey,
    pub curator: Pubkey,
    pub decimals_offset: u8,
    pub virtual_shares: u128,
    pub virtual_assets: u128,
}

#[event]
pub struct ChildAdded {
    pub allocator_vault: Pubkey,
    pub child_vault: Pubkey,
    pub child_program: Pubkey,
    pub max_weight_bps: u16,
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
pub struct Allocate {
    pub allocator_vault: Pubkey,
    pub child_vault: Pubkey,
    pub assets: u64,
}

#[event]
pub struct Withdraw {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub owner: Pubkey,
    pub assets: u64,
    pub shares: u64,
}

#[event]
pub struct Harvest {
    pub allocator_vault: Pubkey,
    pub child_vault: Pubkey,
    pub yield_realized: u64,
}

#[event]
pub struct Deallocate {
    pub allocator_vault: Pubkey,
    pub child_vault: Pubkey,
    pub shares_burned: u64,
    pub assets_received: u64,
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
pub struct CuratorTransferred {
    pub vault: Pubkey,
    pub old_curator: Pubkey,
    pub new_curator: Pubkey,
}

#[event]
pub struct ChildRemoved {
    pub allocator_vault: Pubkey,
    pub child_vault: Pubkey,
}

#[event]
pub struct WeightsUpdated {
    pub allocator_vault: Pubkey,
    pub child_vault: Pubkey,
    pub old_max_weight_bps: u16,
    pub new_max_weight_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum RebalanceAction {
    Deposit,
    Withdraw,
}

#[event]
pub struct Rebalance {
    pub allocator_vault: Pubkey,
    pub child_vault: Pubkey,
    pub action: RebalanceAction,
    pub amount: u64,
}
