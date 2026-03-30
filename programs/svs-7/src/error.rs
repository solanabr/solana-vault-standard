//! Vault error codes.

use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
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

    #[msg("New authority cannot be the zero address")]
    InvalidAuthority,

    // Module errors (always defined for IDL compatibility — not behind #[cfg])
    #[msg("Deposit would exceed global vault cap")]
    GlobalCapExceeded,

    #[msg("Deposit would exceed per-user cap")]
    UserCapExceeded,

    #[msg("Entry fee exceeds maximum")]
    EntryFeeExceedsMax,

    #[msg("Exit fee exceeds maximum")]
    ExitFeeExceedsMax,

    #[msg("Management fee exceeds maximum")]
    ManagementFeeExceedsMax,

    #[msg("Performance fee exceeds maximum")]
    PerformanceFeeExceedsMax,

    #[msg("Lock duration exceeds maximum")]
    LockDurationExceedsMax,

    #[msg("Shares are locked and cannot be redeemed yet")]
    SharesLocked,

    #[msg("Address is not whitelisted")]
    NotWhitelisted,

    #[msg("Address is blacklisted")]
    Blacklisted,

    #[msg("Account is frozen")]
    AccountFrozen,

    #[msg("Invalid merkle proof")]
    InvalidProof,

    #[msg("No fees to claim")]
    NothingToClaim,

    #[msg("Invalid fee configuration")]
    InvalidFeeConfig,

    #[msg("Invalid cap configuration")]
    InvalidCapConfig,
}
