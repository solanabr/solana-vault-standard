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

    #[msg("Maximum number of assets exceeded")]
    MaxAssetsExceeded,

    #[msg("Invalid weight — would exceed 10000 bps")]
    InvalidWeight,

    #[msg("Weights must sum to 10000 bps for financial operations")]
    WeightsNotFullyAllocated,

    #[msg("Oracle price is stale")]
    OracleStale,

    #[msg("Oracle price is invalid")]
    OracleInvalid,

    #[msg("Oracle confidence interval too wide")]
    OracleUncertain,

    #[msg("Asset entry not found in vault")]
    AssetNotFound,

    #[msg("Asset vault balance must be zero to remove")]
    AssetVaultNotEmpty,

    #[msg("Invalid remaining accounts length")]
    InvalidRemainingAccounts,

    #[msg("Invalid asset entry PDA")]
    InvalidAssetEntry,

    #[msg("Invalid asset vault account")]
    InvalidAssetVault,

    #[msg("New authority cannot be the default pubkey")]
    InvalidNewAuthority,

    #[msg("Incorrect number of weights provided")]
    WeightsLengthMismatch,

    #[msg("Incorrect number of min amounts provided")]
    MinAmountsLengthMismatch,

    #[msg("Rebalance: received less than minimum")]
    RebalanceSlippageExceeded,
}
