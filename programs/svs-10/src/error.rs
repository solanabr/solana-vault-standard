use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
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
    #[msg("Insufficient shares balance")]
    InsufficientShares,
    #[msg("Insufficient assets in vault")]
    InsufficientAssets,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Deposit amount below minimum threshold")]
    DepositTooSmall,
    #[msg("Request is not in Pending status")]
    RequestNotPending,
    #[msg("Request is not in Fulfilled status")]
    RequestNotFulfilled,
    #[msg("A pending request already exists for this user")]
    RequestAlreadyExists,
    #[msg("Operator not approved for this action")]
    OperatorNotApproved,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Invalid account provided")]
    InvalidAccount,
}
