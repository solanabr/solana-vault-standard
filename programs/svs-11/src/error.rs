use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,

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

    #[msg("Unauthorized")]
    Unauthorized,

    #[msg("Deposit amount below minimum investment")]
    DepositTooSmall,

    #[msg("Request is not in pending status")]
    RequestNotPending,

    #[msg("Request is not in approved status")]
    RequestNotApproved,

    #[msg("Insufficient liquidity in vault")]
    InsufficientLiquidity,

    #[msg("Investment window is closed")]
    InvestmentWindowClosed,

    #[msg("Investment window is already open")]
    InvestmentWindowAlreadyOpen,

    #[msg("Invalid address: cannot be the zero address")]
    InvalidAddress,

    #[msg("Account is frozen")]
    AccountFrozen,

    #[msg("Attestation account not owned by attestation program")]
    InvalidAttestationProgram,

    #[msg("Invalid attestation account")]
    InvalidAttestation,

    #[msg("Attestation issuer does not match vault attester")]
    InvalidAttester,

    #[msg("Attestation has been revoked")]
    AttestationRevoked,

    #[msg("Attestation has expired")]
    AttestationExpired,

    #[msg("Oracle price data is stale")]
    OracleStale,

    #[msg("Oracle price is invalid")]
    OracleInvalidPrice,

    #[msg("Oracle account owner does not match vault.oracle_program")]
    OracleInvalidProgram,

    #[msg("Oracle price deviation exceeds max_deviation_bps")]
    OracleDeviationExceeded,

    #[msg("Deposit would exceed global vault cap")]
    GlobalCapExceeded,

    #[msg("Entry fee exceeds maximum")]
    EntryFeeExceedsMax,

    #[msg("Lock duration exceeds maximum")]
    LockDurationExceedsMax,

    #[msg("Exit fee exceeds maximum")]
    ExitFeeExceedsMax,

    #[msg("Management fee exceeds maximum")]
    ManagementFeeExceedsMax,

    #[msg("Performance fee exceeds maximum")]
    PerformanceFeeExceedsMax,

    #[msg("Deposit would exceed per-user cap")]
    PerUserCapExceeded,

    #[msg("Invalid fee configuration")]
    InvalidFeeConfig,

    #[msg("Invalid cap configuration")]
    InvalidCapConfig,

    #[msg("Invalid lock configuration")]
    InvalidLockConfig,

    #[msg("Invalid staleness configuration")]
    InvalidStalenessConfig,

    #[msg("Oracle change timelock not expired")]
    OracleChangeTooEarly,

    #[msg("No pending oracle change")]
    OracleChangeNotRequested,

    #[msg("Max deviation exceeds 2000 bps")]
    MaxDeviationTooHigh,

    #[msg("Oracle program is not a known oracle (Pyth or Switchboard)")]
    InvalidOracleProgram,

    #[msg(
        "Unauthorized compliance action: caller is not authority, manager, or compliance officer"
    )]
    UnauthorizedComplianceAction,

    #[msg("update_oracle_config is deprecated: use request_oracle_change + apply_oracle_change for oracle address changes, and update_oracle_params for staleness/deviation settings")]
    OracleConfigDeprecated,

    #[msg("No pending authority transfer")]
    NoPendingTransfer,

    #[msg("Signer does not match pending authority")]
    InvalidPendingAuthority,

    #[msg("Cancellation too early — minimum lock period not elapsed")]
    CancelTooEarly,

    #[msg("Cannot use deprecated transfer while a two-step transfer is pending")]
    PendingTransferExists,

    // -------------------------------------------------------------------------
    // NavOracle integration error variants
    // -------------------------------------------------------------------------
    #[msg("NAV oracle account is missing or empty")]
    OracleAccountMissing,

    #[msg("NAV oracle account data layout, owner, or PDA derivation invalid")]
    OracleAccountInvalid,

    #[msg("NAV oracle pool field does not match this vault")]
    OraclePoolMismatch,

    #[msg("NAV oracle publisher does not match expected publisher")]
    OraclePublisherMismatch,

    #[msg("NAV oracle sequence has not advanced (replay)")]
    OracleSequenceStale,

    #[msg("CreditVault.oracle_source must be 0 (mock) or 1 (nav_oracle); other values reserved")]
    OracleSourceInvalid,

    #[msg("Mint account does not deserialize as a valid Token-2022 mint")]
    InvalidMintAccount,

    #[msg("next_settlement_at must be in [now, now + MAX_SETTLEMENT_HORIZON_SECS]")]
    SettlementHorizonOutOfRange,

    #[msg(
        "remaining_accounts do not match the shares mint's ExtraAccountMetaList — wrong order, missing accounts, or stale hook config"
    )]
    HookExtrasMismatch,

    #[msg("request has partial fulfillment — cancel/reject not allowed once approve_redeem has paid out")]
    RequestPartiallyFulfilled,
}
