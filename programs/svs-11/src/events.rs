use anchor_lang::prelude::*;

#[event]
pub struct PoolInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub manager: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub vault_id: u64,
}

#[event]
pub struct InvestmentWindowOpened {
    pub vault: Pubkey,
    pub opened_at: i64,
}

#[event]
pub struct InvestmentWindowClosed {
    pub vault: Pubkey,
    pub closed_at: i64,
}

#[event]
pub struct DepositRequested {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub assets: u64,
}

#[event]
pub struct DepositApproved {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub assets: u64,
    pub shares: u64,
}

#[event]
pub struct DepositRejected {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub assets_returned: u64,
}

#[event]
pub struct DepositCancelled {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub assets_returned: u64,
}

#[event]
pub struct DepositClaimed {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub receiver: Pubkey,
    pub shares: u64,
}

#[event]
pub struct RedeemRequested {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub shares: u64,
}

#[event]
pub struct RedeemApproved {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub shares: u64,
    pub assets: u64,
}

#[event]
pub struct RedeemCancelled {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub shares_returned: u64,
}

#[event]
pub struct RedemptionClaimed {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub receiver: Pubkey,
    pub assets: u64,
}

#[event]
pub struct Repaid {
    pub vault: Pubkey,
    pub amount: u64,
    pub new_total_assets: u64,
}

#[event]
pub struct AccountFrozen {
    pub vault: Pubkey,
    pub account: Pubkey,
}

#[event]
pub struct AccountUnfrozen {
    pub vault: Pubkey,
    pub account: Pubkey,
}

#[event]
pub struct VaultStatusChanged {
    pub vault: Pubkey,
    pub paused: bool,
}

#[event]
pub struct AuthorityTransferred {
    pub vault: Pubkey,
    pub previous: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct ManagerChanged {
    pub vault: Pubkey,
    pub previous: Pubkey,
    pub new_manager: Pubkey,
}
