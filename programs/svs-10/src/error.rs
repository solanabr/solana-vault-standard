use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,

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

    #[msg("Unauthorized")]
    Unauthorized,

    #[msg("Request is not in Pending status")]
    RequestNotPending,

    #[msg("Request is not in Fulfilled status")]
    RequestNotFulfilled,

    #[msg("Operator not approved for this action")]
    OperatorNotApproved,

    #[msg("Vault operator is not set")]
    OperatorNotSet,

    #[msg("Cancel delay has not elapsed")]
    CancelTooEarly,

    #[msg("Cancel delay exceeds maximum")]
    CancelDelayExceedsMax,

    #[msg("Insufficient assets in vault")]
    InsufficientAssets,

    #[msg("Insufficient shares")]
    InsufficientShares,

    #[msg("Invalid operator address")]
    InvalidOperator,

    #[msg("Invalid authority address")]
    InvalidAuthority,

    #[msg("Invalid cancel delay")]
    InvalidCancelDelay,

    #[msg("Invalid max staleness")]
    InvalidMaxStaleness,

    #[msg("Oracle price is stale")]
    StaleOraclePrice,

    #[msg("Invalid oracle price")]
    InvalidOraclePrice,

    #[msg("Oracle vault mismatch")]
    OracleVaultMismatch,

    #[msg("Deposit would exceed global vault cap")]
    GlobalCapExceeded,

    #[msg("Entry fee exceeds maximum")]
    EntryFeeExceedsMax,

    #[msg("Lock duration exceeds maximum")]
    LockDurationExceedsMax,
}
