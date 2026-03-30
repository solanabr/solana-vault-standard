use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    // --- Input errors ---
    #[msg("Input amount must be greater than zero")]
    ZeroAmount,
    #[msg("Deposit amount is smaller than minimum required")]
    DepositTooSmall,
    #[msg("Specified asset has invalid decimals")]
    InvalidAssetDecimals,

    // --- State errors ---
    #[msg("The vault is currently paused")]
    VaultPaused,
    #[msg("The vault is not currently paused")]
    VaultNotPaused,
    #[msg("The caller is not authorized for this operation")]
    Unauthorized,

    // --- Math errors ---
    #[msg("Mathematical operation resulted in overflow")]
    MathOverflow,
    #[msg("Attempted division by zero")]
    DivisionByZero,

    // --- Balance errors ---
    #[msg("Account has insufficient shares for withdrawal")]
    InsufficientShares,
    #[msg("Vault has insufficient underlying assets")]
    InsufficientAssets,

    // --- Protection errors ---
    #[msg("Slippage limit has been exceeded")]
    SlippageExceeded,

    // --- SVS-9 Specific errors ---
    #[msg("Insufficient buffer available in the idle vault")]
    InsufficientBuffer,
    #[msg("Program ID provided for child vault is invalid")]
    InvalidChildProgram,
    #[msg("Public key provided for child vault is invalid")]
    InvalidChildVault,
    #[msg("The child variant is not supported")]
    UnsupportedChildVariant,
    #[msg("Allocations for this child vault are disabled")]
    ChildAllocationDisabled,
    #[msg("Cannot remove child vault with deposited assets – deallocate first")]
    ChildHasAssets,
    #[msg("Child vault allocation exceeds maximum allowed weight")]
    MaxWeightExceeded,
    #[msg("Invalid number of remaining accounts provided for asset computation")]
    InvalidRemainingAccounts,
    #[msg("Duplicate child vault found in remaining accounts")]
    DuplicateChildVault,
}
