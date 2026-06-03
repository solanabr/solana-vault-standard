use anchor_lang::prelude::*;

#[event]
pub struct WrapperInitialized {
    pub pool: Pubkey,
    pub permissioned_mint: Pubkey,
    pub derwa_mint: Pubkey,
    pub attestation_program: Pubkey,
    pub attestation_issuer: Pubkey,
    pub required_attestation_type: u8,
}

#[event]
pub struct Wrapped {
    pub pool: Pubkey,
    pub investor: Pubkey,
    pub amount: u64,
    pub locked_supply_after: u64,
}

#[event]
pub struct Unwrapped {
    pub pool: Pubkey,
    pub investor: Pubkey,
    pub amount: u64,
    pub locked_supply_after: u64,
    pub attestation_subject: Pubkey,
}
