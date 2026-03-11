use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Vault is paused")]
    VaultPaused,
    #[msg("Vault is not paused")]
    VaultNotPaused,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Insufficient assets in vault")]
    InsufficientAssets,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Deposit amount below minimum")]
    DepositTooSmall,
    #[msg("Investment window is not open")]
    WindowNotOpen,
    #[msg("Investment window is already open")]
    WindowAlreadyOpen,
    #[msg("KYC attestation not found or invalid")]
    KycNotVerified,
    #[msg("Request is not in Pending status")]
    RequestNotPending,
    #[msg("Request is not in Approved status")]
    RequestNotApproved,
    #[msg("Request has already been cancelled")]
    RequestAlreadyCancelled,
    #[msg("Account is frozen")]
    AccountFrozen,
    #[msg("Account is not frozen")]
    AccountNotFrozen,
    #[msg("Invalid asset decimals")]
    InvalidAssetDecimals,
    #[msg("Invalid account")]
    InvalidAccount,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Slippage exceeded")]
    SlippageExceeded,
}
