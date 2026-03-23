use anchor_lang::prelude::*;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub shares_mint: Pubkey,
    pub vault_id: u64,
    pub base_decimals: u8,
}

#[event]
pub struct AssetAdded {
    pub vault: Pubkey,
    pub asset_mint: Pubkey,
    pub oracle: Pubkey,
    pub target_weight_bps: u16,
    pub index: u8,
}

#[event]
pub struct AssetRemoved {
    pub vault: Pubkey,
    pub asset_mint: Pubkey,
    pub index: u8,
}

#[event]
pub struct WeightsUpdated {
    pub vault: Pubkey,
    pub new_weights: Vec<u16>,
}

#[event]
pub struct SingleDeposit {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub asset_mint: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub deposit_value: u64,
}

#[event]
pub struct ProportionalDeposit {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub amounts: Vec<u64>,
    pub shares: u64,
    pub total_deposit_value: u64,
}

#[event]
pub struct SingleRedeem {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub asset_mint: Pubkey,
    pub shares: u64,
    pub amount_out: u64,
}

#[event]
pub struct ProportionalRedeem {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub shares: u64,
    pub amounts: Vec<u64>,
}

#[event]
pub struct Rebalance {
    pub vault: Pubkey,
    pub from_asset: Pubkey,
    pub to_asset: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
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
