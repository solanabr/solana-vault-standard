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

    #[msg("Unauthorized - caller is not vault authority")]
    Unauthorized,

    #[msg("Deposit amount below minimum threshold")]
    DepositTooSmall,

    #[msg("Vault is not paused")]
    VaultNotPaused,

    #[msg("Request is not in pending status")]
    RequestNotPending,

    #[msg("Request is not in fulfilled status")]
    RequestNotFulfilled,

    #[msg("Operator not approved for this action")]
    OperatorNotApproved,

    #[msg("Oracle price data is stale")]
    OracleStale,

    #[msg("Insufficient liquidity in vault")]
    InsufficientLiquidity,

    #[msg("Oracle price deviation exceeds maximum")]
    OracleDeviationExceeded,

    #[msg("Caller is not the request owner")]
    InvalidRequestOwner,

    // Module errors (available with "modules" feature)
    #[msg("Deposit would exceed global vault cap")]
    GlobalCapExceeded,

    #[msg("Entry fee exceeds maximum")]
    EntryFeeExceedsMax,

    #[msg("Lock duration exceeds maximum")]
    LockDurationExceedsMax,

    #[msg("Invalid address: cannot be the zero address")]
    InvalidAddress,
}
