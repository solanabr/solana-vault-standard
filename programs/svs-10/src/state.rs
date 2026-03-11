use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum RequestStatus {
    Pending,
    Fulfilled,
    Claimed,
    Cancelled,
}

/// SVS-10 Async Vault
/// Seeds: ["async_vault", asset_mint, vault_id.to_le_bytes()]
#[account]
pub struct AsyncVault {
    pub authority: Pubkey,
    pub operator: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub asset_vault: Pubkey,
    pub share_escrow: Pubkey,
    pub total_assets: u64,
    pub total_shares: u64,
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub vault_id: u64,
    pub _reserved: [u8; 64],
}

impl AsyncVault {
    pub const LEN: usize = 8
        + 32 + 32 + 32 + 32 + 32 + 32
        + 8 + 8 + 1 + 1 + 1 + 8 + 64;
}

/// Deposit request PDA
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
    pub fulfilled_at: i64,
    pub bump: u8,
}

impl DepositRequest {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 8 + 1;
}

/// Redeem request PDA
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
    pub fulfilled_at: i64,
    pub bump: u8,
}

impl RedeemRequest {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 8 + 1;
}

/// Per-user operator approval
/// Seeds: ["operator_approval", vault, owner, operator]
#[account]
pub struct OperatorApproval {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub operator: Pubkey,
    pub approved: bool,
    pub bump: u8,
}

impl OperatorApproval {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 1 + 1;
}
