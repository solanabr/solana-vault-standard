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
    pub asset_mint: Pubkey,
    pub old_weight_bps: u16,
    pub new_weight_bps: u16,
}

#[event]
pub struct DepositSingle {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub asset_mint: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub deposit_value: u64,
}

#[event]
pub struct DepositProportional {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub base_amount: u64,
    pub shares: u64,
    pub total_value: u64,
}

#[event]
pub struct RedeemProportional {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub shares: u64,
    pub total_value: u64,
}

#[event]
pub struct RedeemSingle {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub asset_mint: Pubkey,
    pub shares: u64,
    pub assets_out: u64,
    pub redeem_value: u64,
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
pub struct OraclePriceUpdated {
    pub vault: Pubkey,
    pub asset_mint: Pubkey,
    pub price: u64,
    pub updated_at: i64,
}
