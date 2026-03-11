use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum RequestStatus {
    Pending,
    Approved,
    Rejected,
    Cancelled,
    Claimed,
}

/// SVS-11 Credit Markets Vault
/// Seeds: ["credit_vault", asset_mint, vault_id.to_le_bytes()]
#[account]
pub struct CreditVault {
    pub authority: Pubkey,
    pub manager: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub asset_vault: Pubkey,
    pub share_escrow: Pubkey,
    pub kyc_registry: Pubkey,
    pub nav_oracle: Pubkey,
    pub total_assets: u64,
    pub total_shares: u64,
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub window_open: bool,
    pub vault_id: u64,
    pub _reserved: [u8; 64],
}

impl CreditVault {
    pub const LEN: usize = 8
        + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32
        + 8 + 8 + 1 + 1 + 1 + 1 + 8 + 64;
}

/// KYC attestation account (created by KYC registry program)
/// SVS-11 reads this as a generic account — just checks it exists and is valid
#[account]
pub struct KycAttestation {
    pub registry: Pubkey,
    pub subject: Pubkey,
    pub valid_until: i64,
    pub revoked: bool,
}

impl KycAttestation {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1;
}

/// NAV oracle price account (written by oracle program)
#[account]
pub struct OraclePrice {
    pub authority: Pubkey,
    pub price_per_share: u64,
    pub decimals: u8,
    pub updated_at: i64,
}

impl OraclePrice {
    pub const LEN: usize = 8 + 32 + 8 + 1 + 8;
}

/// Deposit request
/// Seeds: ["deposit_request", vault, owner]
#[account]
pub struct DepositRequest {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub receiver: Pubkey,
    pub assets_locked: u64,
    pub shares_claimable: u64,
    pub status: RequestStatus,
    pub requested_at: i64,
    pub bump: u8,
}

impl DepositRequest {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 1;
}

/// Redeem request
/// Seeds: ["redeem_request", vault, owner]
#[account]
pub struct RedeemRequest {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub receiver: Pubkey,
    pub shares_locked: u64,
    pub assets_claimable: u64,
    pub status: RequestStatus,
    pub requested_at: i64,
    pub bump: u8,
}

impl RedeemRequest {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 1;
}

/// Frozen account marker
/// Seeds: ["frozen_account", vault, target_pubkey]
#[account]
pub struct FrozenAccount {
    pub vault: Pubkey,
    pub account: Pubkey,
    pub frozen_at: i64,
    pub bump: u8,
}

impl FrozenAccount {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1;
}
