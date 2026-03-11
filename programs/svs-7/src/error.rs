//! SVS-7 error codes.
use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Vault is paused")]
    VaultPaused,
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
    #[msg("sync() requires Stored balance model")]
    NotStoredModel,
    #[msg("Invalid account provided")]
    InvalidAccount,
    #[msg("Expected wSOL native mint")]
    InvalidNativeMint,
}
