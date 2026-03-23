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

    #[msg("Deposit amount below minimum investment")]
    DepositTooSmall,

    #[msg("Request is not in pending status")]
    RequestNotPending,

    #[msg("Request is not in approved status")]
    RequestNotApproved,

    #[msg("Insufficient liquidity in vault")]
    InsufficientLiquidity,

    #[msg("Investment window is closed")]
    InvestmentWindowClosed,

    #[msg("Investment window is already open")]
    InvestmentWindowAlreadyOpen,

    #[msg("Invalid address: cannot be the zero address")]
    InvalidAddress,

    #[msg("Account is frozen")]
    AccountFrozen,

    #[msg("Attestation account not owned by attestation program")]
    InvalidAttestationProgram,

    #[msg("Invalid attestation account")]
    InvalidAttestation,

    #[msg("Attestation issuer does not match vault attester")]
    InvalidAttester,

    #[msg("Attestation has been revoked")]
    AttestationRevoked,

    #[msg("Attestation has expired")]
    AttestationExpired,

    #[msg("Oracle price data is stale")]
    OracleStale,

    #[msg("Oracle price is invalid")]
    OracleInvalidPrice,

    #[msg("Oracle account owner does not match vault.oracle_program")]
    OracleInvalidProgram,

    #[msg("Deposit would exceed global vault cap")]
    GlobalCapExceeded,

    #[msg("Entry fee exceeds maximum")]
    EntryFeeExceedsMax,

    #[msg("Lock duration exceeds maximum")]
    LockDurationExceedsMax,

    #[msg("Exit fee exceeds maximum")]
    ExitFeeExceedsMax,

    #[msg("Management fee exceeds maximum")]
    ManagementFeeExceedsMax,

    #[msg("Performance fee exceeds maximum")]
    PerformanceFeeExceedsMax,

    #[msg("Deposit would exceed per-user cap")]
    PerUserCapExceeded,

    #[msg("Invalid fee configuration")]
    InvalidFeeConfig,

    #[msg("Invalid cap configuration")]
    InvalidCapConfig,

    #[msg("Invalid lock configuration")]
    InvalidLockConfig,

    #[msg("Invalid staleness configuration")]
    InvalidStalenessConfig,
}
