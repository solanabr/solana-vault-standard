//! Error codes for SVS-9 allocator vault.

use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Invalid child program")]
    InvalidChildProgram,
    #[msg("Invalid child vault")]
    InvalidChildVault,
    #[msg("Unsupported child variant")]
    UnsupportedChildVariant,
    #[msg("Child allocation disabled")]
    ChildAllocationDisabled,
    #[msg("Insufficient idle buffer")]
    InsufficientBuffer,
    #[msg("Insufficient liquidity")]
    InsufficientLiquidity,
    #[msg("Invalid account data")]
    InvalidAccountData,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Division by zero")]
    DivisionByZero,
    #[msg("Invalid weight")]
    InvalidWeight,
    #[msg("Too many children")]
    TooManyChildren,
    #[msg("Child already exists")]
    ChildAlreadyExists,
    #[msg("Child not found")]
    ChildNotFound,
    #[msg("Child has non-zero shares")]
    ChildHasShares,
    #[msg("Invalid curator")]
    InvalidCurator,
    #[msg("Vault paused")]
    VaultPaused,
    #[msg("Zero amount")]
    ZeroAmount,
    #[msg("Slippage exceeded")]
    SlippageExceeded,
    #[msg("Invalid authority")]
    InvalidAuthority,
    #[msg("Invalid signer")]
    InvalidSigner,
    #[msg("CPI failed")]
    CpiFailed,
    #[msg("Invalid allocation index")]
    InvalidAllocationIndex,
    #[msg("Weight sum exceeds limit")]
    WeightSumExceedsLimit,
    #[msg("Invalid decimals offset")]
    InvalidDecimalsOffset,
    #[msg("Insufficient assets")]
    InsufficientAssets,
    #[msg("Insufficient shares")]
    InsufficientShares,
    #[msg("Asset decimals too high")]
    AssetDecimalsTooHigh,
    #[msg("No yield to harvest")]
    NoYieldToHarvest,
    #[msg("Cache not ready")]
    CacheNotReady,
}
