use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    #[msg("Vault has been wiped by total loss — no new deposits")]
    VaultWiped,

    #[msg("Vault is paused")]
    VaultPaused,

    #[msg("Vault is not paused")]
    VaultNotPaused,

    #[msg("Maximum number of tranches reached")]
    MaxTranchesReached,

    #[msg("Tranche priority already exists in this vault")]
    DuplicatePriority,

    #[msg("Invalid tranche index")]
    InvalidTrancheIndex,

    #[msg("Subordination ratio breached")]
    SubordinationBreach,

    #[msg("Tranche cap exceeded")]
    CapExceeded,

    #[msg("Insufficient liquidity in asset vault")]
    InsufficientLiquidity,

    #[msg("Insufficient allocation in tranche")]
    InsufficientAllocation,

    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,

    #[msg("Loss exceeds total vault assets")]
    TotalLoss,

    #[msg("Arithmetic overflow")]
    MathOverflow,

    #[msg("Asset decimals must be <= 9")]
    InvalidAssetDecimals,

    #[msg("Unauthorized caller")]
    Unauthorized,

    #[msg("Subordination basis points must be <= 10000")]
    InvalidSubordinationConfig,

    #[msg("Cap basis points must be > 0 and <= 10000")]
    InvalidCapConfig,

    #[msg("Target yield basis points must be <= 10000")]
    InvalidYieldConfig,

    #[msg("Invalid waterfall mode")]
    InvalidWaterfallMode,

    #[msg("Tranche does not belong to this vault")]
    TrancheVaultMismatch,

    #[msg("Wrong number of tranche accounts provided")]
    WrongTrancheCount,

    #[msg("Duplicate tranche account provided")]
    DuplicateTranche,

    #[msg("Insufficient shares balance")]
    InsufficientShares,

    #[msg("Invalid address: cannot be the zero address")]
    InvalidAddress,

    #[msg("Invalid fee configuration")]
    InvalidFeeConfig,

    #[msg("Invalid lock configuration")]
    InvalidLockConfig,

    #[msg("No pending authority transfer")]
    NoPendingTransfer,

    #[msg("Signer does not match pending authority")]
    InvalidPendingAuthority,

    #[msg("Cannot transfer authority while a two-step transfer is pending")]
    PendingTransferExists,

    #[msg("Tranche total_shares diverged from shares_mint supply")]
    SharesMismatch,

    #[msg("Yield distribution cooldown has not elapsed (minimum 1 hour between distributions)")]
    YieldCooldownNotElapsed,
}
