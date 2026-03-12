use anchor_lang::prelude::*;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub manager: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub vault_id: u64,
}

#[event]
pub struct InvestmentRequested {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct InvestmentApproved {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub nav: u64,
}

#[event]
pub struct InvestmentClaimed {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub shares: u64,
}

#[event]
pub struct InvestmentRejected {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub amount: u64,
    pub reason_code: u8,
}

#[event]
pub struct InvestmentCancelled {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct RedemptionRequested {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub shares: u64,
}

#[event]
pub struct RedemptionApproved {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub shares: u64,
    pub assets: u64,
    pub nav: u64,
}

#[event]
pub struct RedemptionClaimed {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub assets: u64,
}

#[event]
pub struct RedemptionCancelled {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub shares: u64,
}

#[event]
pub struct Repayment {
    pub vault: Pubkey,
    pub amount: u64,
    pub new_total_assets: u64,
}

#[event]
pub struct DrawDown {
    pub vault: Pubkey,
    pub amount: u64,
    pub destination: Pubkey,
}

#[event]
pub struct AccountFrozen {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub frozen_by: Pubkey,
}

#[event]
pub struct AccountUnfrozen {
    pub vault: Pubkey,
    pub investor: Pubkey,
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
pub struct ManagerChanged {
    pub vault: Pubkey,
    pub old_manager: Pubkey,
    pub new_manager: Pubkey,
}

#[event]
pub struct WindowOpened {
    pub vault: Pubkey,
}

#[event]
pub struct WindowClosed {
    pub vault: Pubkey,
}

#[event]
pub struct AttesterUpdated {
    pub vault: Pubkey,
    pub old_attester: Pubkey,
    pub new_attester: Pubkey,
    pub old_attestation_program: Pubkey,
    pub new_attestation_program: Pubkey,
}

#[event]
pub struct OracleConfigUpdated {
    pub vault: Pubkey,
    pub old_oracle: Pubkey,
    pub new_oracle: Pubkey,
    pub old_program: Pubkey,
    pub new_program: Pubkey,
    pub new_max_staleness: i64,
}
