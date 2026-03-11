//! Vault error codes.

use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,

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

    #[msg("Unauthorized - caller is not authorized")]
    Unauthorized,

    #[msg("Vault is not paused")]
    VaultNotPaused,

    #[msg("Request status must be Pending")]
    RequestNotPending,

    #[msg("Request status must be Fulfilled")]
    RequestNotFulfilled,

    #[msg("User already has a pending request for this vault")]
    RequestAlreadyExists,

    #[msg("Operator not approved for this action")]
    OperatorNotApproved,

    #[msg("Signer is not the vault operator")]
    InvalidOperator,

    #[msg("No assets in claimable escrow")]
    EscrowEmpty,

    #[msg("Entry fee exceeds maximum")]
    EntryFeeExceedsMax,

    #[msg("Lock duration exceeds maximum")]
    LockDurationExceedsMax,

    #[msg("Deposit would exceed global vault cap")]
    GlobalCapExceeded,
}
