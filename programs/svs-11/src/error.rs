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

    #[msg("Insufficient assets in vault")]
    InsufficientAssets,

    #[msg("Insufficient shares")]
    InsufficientShares,

    #[msg("Invalid authority address")]
    InvalidAuthority,

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

    #[msg("Fee configuration exceeds maximum")]
    FeeExceedsMax,

    #[msg("Invalid cap configuration")]
    InvalidCapConfig,

    #[msg("Lock duration exceeds maximum")]
    LockDurationExceedsMax,

    #[msg("Attestation has expired")]
    AttestationExpired,

    #[msg("Attestation has been revoked")]
    AttestationRevoked,

    #[msg("Invalid attester")]
    InvalidAttester,

    #[msg("Attestation not found in remaining accounts")]
    AttestationNotFound,

    #[msg("Investment window is closed")]
    InvestmentWindowClosed,

    #[msg("Account is frozen")]
    AccountFrozen,

    #[msg("Account is not frozen")]
    AccountNotFrozen,

    #[msg("Amount below minimum investment")]
    BelowMinimumInvestment,

    #[msg("Oracle is required for this vault")]
    OracleRequired,

    #[msg("Insufficient liquidity for redemption")]
    InsufficientLiquidity,

    #[msg("Invalid manager address")]
    InvalidManager,

    #[msg("Redemption request has not been approved yet")]
    RequestNotApproved,

    #[msg("Investment window is already open")]
    WindowAlreadyOpen,

    #[msg("Investment window is already closed")]
    WindowAlreadyClosed,
}
