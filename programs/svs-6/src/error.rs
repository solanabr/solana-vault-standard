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

    #[msg("Asset decimals must be <= 9")]
    InvalidAssetDecimals,

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

    #[msg("New authority cannot be the zero address")]
    InvalidAddress,

    #[msg("No pending authority transfer")]
    NoPendingTransfer,

    #[msg("Signer is not the pending authority")]
    InvalidPendingAuthority,

    #[msg("Deposit amount below minimum threshold")]
    DepositTooSmall,

    #[msg("Vault is not paused")]
    VaultNotPaused,

    #[msg("Stream duration must be at least 60 seconds")]
    StreamTooShort,

    #[msg("Cannot start new stream while current stream is still active")]
    StreamStillActive,

    #[msg("Account not configured for confidential transfers")]
    AccountNotConfigured,

    #[msg("Pending balance not applied - call apply_pending first")]
    PendingBalanceNotApplied,

    #[msg("Invalid proof data")]
    InvalidProof,

    #[msg("Confidential transfer extension not initialized")]
    ConfidentialTransferNotInitialized,

    #[msg("Invalid ciphertext format")]
    InvalidCiphertext,

    // Module errors
    #[msg("Invalid fee configuration")]
    InvalidFeeConfig,

    #[msg("Invalid cap configuration")]
    InvalidCapConfig,

    #[msg("Lock duration exceeds maximum")]
    LockDurationExceedsMax,

    #[msg("Cannot use deprecated transfer while a two-step transfer is pending")]
    PendingTransferExists,
}
