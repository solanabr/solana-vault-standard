//! SVS-9 custom error codes.

use anchor_lang::prelude::*;

#[error_code]
pub enum AllocatorError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Deposit amount below minimum threshold")]
    DepositTooSmall,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Weight exceeds maximum basis points (10000)")]
    InvalidWeight,
    #[msg("Idle buffer basis points invalid (must be < 10000)")]
    InvalidIdleBuffer,
    #[msg("Vault is paused")]
    VaultPaused,
    #[msg("Vault is not paused")]
    VaultNotPaused,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Unauthorized curator")]
    UnauthorizedCurator,
    #[msg("Maximum number of child vaults reached (10)")]
    MaxChildrenReached,
    #[msg("Child allocation is disabled")]
    ChildAllocationDisabled,
    #[msg("Invalid child program")]
    InvalidChildProgram,
    #[msg("Invalid child vault")]
    InvalidChildVault,
    #[msg("Unsupported child variant")]
    UnsupportedChildVariant,
    #[msg("Child still has allocated shares")]
    ChildHasShares,
    #[msg("Child allocation not found")]
    ChildNotFound,
    #[msg("Insufficient idle liquidity")]
    InsufficientLiquidity,
    #[msg("Insufficient buffer")]
    InsufficientBuffer,
    #[msg("Max weight exceeded")]
    MaxWeightExceeded,
    #[msg("Insufficient shares balance")]
    InsufficientShares,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Division by zero")]
    DivisionByZero,
    #[msg("Invalid account data layout")]
    InvalidAccountData,
    #[msg("Asset decimals must be <= 9")]
    InvalidAssetDecimals,
}
