//! Vault error codes.

use anchor_lang::prelude::*;

#[error_code]
pub enum SolVaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,

    #[msg("Vault is paused")]
    VaultPaused,

    #[msg("Arithmetic overflow")]
    MathOverflow,

    #[msg("Division by zero")]
    DivisionByZero,

    #[msg("Insufficient shares balance")]
    InsufficientShares,

    #[msg("Insufficient assets in vault")]
    InsufficientAssets,

    #[msg("Unauthorized - caller is not vault authority")]
    Unauthorized,

    #[msg("Deposit amount below minimum threshold")]
    DepositTooSmall,

    #[msg("Vault is not paused")]
    VaultNotPaused,

    #[msg("Invalid asset mint - must be native SOL mint")]
    InvalidAssetMint,

    #[msg("Sync is only supported for Stored balance model")]
    SyncNotSupported,

    #[msg("Invalid balance model")]
    InvalidBalanceModel,

    #[msg("Insufficient SOL balance for withdrawal")]
    InsufficientSolBalance,

    // Module errors (available with "modules" feature)
    #[msg("Deposit would exceed global vault cap")]
    GlobalCapExceeded,

    #[msg("Entry fee exceeds maximum")]
    EntryFeeExceedsMax,

    #[msg("Lock duration exceeds maximum")]
    LockDurationExceedsMax,
}
