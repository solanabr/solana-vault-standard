//! SVS-7 account state definitions.
use anchor_lang::prelude::*;

/// Whether total_assets is read live from wSOL vault or from cached state.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum BalanceModel {
    #[default]
    Live,
    Stored,
}

/// SVS-7 Native SOL Vault
/// Seeds: ["sol_vault", vault_id.to_le_bytes()]
#[account]
pub struct SolVault {
    pub authority: Pubkey,
    pub shares_mint: Pubkey,
    pub wsol_vault: Pubkey,
    pub total_assets: u64,
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub vault_id: u64,
    pub balance_model: BalanceModel,
    pub _reserved: [u8; 64],
}

impl SolVault {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 1 + 1 + 1 + 8 + 1 + 64;
}
