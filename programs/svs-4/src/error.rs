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

    #[msg("Vault is not paused")]
    VaultNotPaused,

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

    #[msg("Deposit amount below minimum threshold")]
    DepositTooSmall,

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

    // Module errors (available with "modules" feature)
    #[msg("Deposit would exceed global vault cap")]
    GlobalCapExceeded,

    #[msg("Entry fee exceeds maximum")]
    EntryFeeExceedsMax,

    #[msg("Lock duration exceeds maximum")]
    LockDurationExceedsMax,

    #[msg("Invalid address: cannot be default/zero")]
    InvalidAddress,

    #[msg("No pending authority transfer")]
    NoPendingTransfer,

    #[msg("Signer does not match pending authority")]
    InvalidPendingAuthority,

    #[msg("Cannot use deprecated transfer while a two-step transfer is pending")]
    PendingTransferExists,

    #[msg("Fee recipient not set — call set_fee_recipient first")]
    FeeRecipientNotSet,

    #[msg("Fee recipient token account does not match vault fee_recipient")]
    InvalidFeeRecipient,

    #[msg("No fees available to collect")]
    NoFeesToCollect,
}
