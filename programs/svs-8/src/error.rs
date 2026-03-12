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

    #[msg("Deposit amount below minimum threshold")]
    DepositTooSmall,

    #[msg("Vault is not paused")]
    VaultNotPaused,

    #[msg("Maximum number of assets (8) already reached")]
    MaxAssetsExceeded,

    #[msg("Asset not found in basket")]
    AssetNotFound,

    #[msg("Asset vault must be empty before removal")]
    AssetVaultNotEmpty,

    #[msg("Target weights must sum to exactly 10000 bps")]
    InvalidWeight,

    #[msg("Oracle price is stale")]
    OracleStale,

    #[msg("Oracle confidence interval too wide")]
    OracleUncertain,

    #[msg("Invalid oracle account")]
    InvalidOracle,

    #[msg("Invalid program ID")]
    InvalidProgram,

    #[msg("Deposit would exceed global vault cap")]
    GlobalCapExceeded,

    #[msg("Entry fee exceeds maximum")]
    EntryFeeExceedsMax,

    #[msg("Lock duration exceeds maximum")]
    LockDurationExceedsMax,
}
