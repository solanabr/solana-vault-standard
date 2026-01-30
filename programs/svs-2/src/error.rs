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
}
