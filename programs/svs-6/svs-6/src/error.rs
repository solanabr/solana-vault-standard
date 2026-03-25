use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    // ── Base errors (6000-6010) — shared across all SVS variants ──

    #[msg("Amount must be greater than zero")]
    ZeroAmount, // 6000

    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded, // 6001

    #[msg("Vault is paused")]
    VaultPaused, // 6002

    #[msg("Asset decimals must be <= 9")]
    InvalidAssetDecimals, // 6003

    #[msg("Arithmetic overflow")]
    MathOverflow, // 6004

    #[msg("Division by zero")]
    DivisionByZero, // 6005

    #[msg("Insufficient shares balance")]
    InsufficientShares, // 6006

    #[msg("Insufficient assets in vault")]
    InsufficientAssets, // 6007

    #[msg("Unauthorized - caller is not vault authority")]
    Unauthorized, // 6008

    #[msg("Deposit amount below minimum threshold")]
    DepositTooSmall, // 6009

    #[msg("Vault is not paused")]
    VaultNotPaused, // 6010

    // ── Confidential Transfer errors (6020-6024) — from SVS-3 ──

    #[msg("Invalid zero-knowledge proof")]
    InvalidProof, // 6020

    #[msg("Proof context account mismatch")]
    ProofContextMismatch, // 6021

    #[msg("Pending balance must be empty before this operation")]
    PendingBalanceNotEmpty, // 6022

    #[msg("Confidential transfers not configured on this account")]
    ConfidentialTransferDisabled, // 6023

    #[msg("Invalid ciphertext format")]
    InvalidCiphertext, // 6024

    // ── Streaming errors (6030-6034) — SVS-5/6 specific ──

    #[msg("No active yield stream")]
    NoActiveStream, // 6030

    #[msg("Yield stream is still active - checkpoint or wait for completion")]
    StreamStillActive, // 6031

    #[msg("Stream duration out of valid range")]
    InvalidStreamDuration, // 6032

    #[msg("Stream amount must be greater than zero")]
    ZeroStreamAmount, // 6033

    #[msg("Insufficient assets in vault to cover stream distribution")]
    InsufficientAssetsForStream, // 6034

    // ── Module errors (6040-6049) — from SVS-3 module_admin ──

    #[msg("Entry fee exceeds maximum allowed")]
    EntryFeeExceedsMax, // 6040

    #[msg("Global cap exceeded")]
    GlobalCapExceeded, // 6041

    #[msg("User cap exceeded")]
    UserCapExceeded, // 6042

    #[msg("Lock duration exceeds maximum allowed")]
    LockDurationExceedsMax, // 6043

    #[msg("Shares are locked")]
    SharesLocked, // 6044

    #[msg("Account is frozen")]
    AccountFrozen, // 6045
}
