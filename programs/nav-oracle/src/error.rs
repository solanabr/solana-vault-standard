use anchor_lang::prelude::*;

#[error_code]
pub enum NavOracleError {
    #[msg("Sequence must increment monotonically")]
    StaleSequence = 7000,

    #[msg("Signature does not match publisher key over canonical payload")]
    InvalidSignature = 7001,

    #[msg("Self-consistency check failed: nav_net != nav_gross × (1 − ter − loss)")]
    InconsistentNav = 7002,

    #[msg("Publisher rotation requires the pool's live CreditVault.authority as signer")]
    UnauthorizedRotation = 7003,

    #[msg("Caller is not the registered publisher for this NavAccount")]
    UnauthorizedPublisher = 7004,

    #[msg("Timestamp must not be in the future")]
    TimestampInFuture = 7005,

    #[msg("Timestamp is too far in the past (> 60s skew)")]
    TimestampInPast = 7006,

    #[msg("ter_bps + loss_provision_bps must be < 10_000 (fees cannot equal or exceed gross)")]
    FeesExceedGross = 7007,

    #[msg("nav_gross must be > 0 (zero NAV has no economic meaning)")]
    ZeroNavGross = 7008,

    #[msg("new_publisher cannot be the default pubkey")]
    InvalidNewPublisher = 7009,

    #[msg("initialize signer must be the pool's CreditVault.authority")]
    UnauthorizedPoolInit = 7010,

    #[msg("pool account data is missing or shorter than CreditVault.authority offset")]
    PoolAccountInvalid = 7011,

    #[msg("New NAV deviates more than max_deviation_bps from the previously published NAV")]
    DeviationExceeded = 7012,

    #[msg("max_deviation_bps must be > 0 (a zero ceiling rejects every consecutive publish)")]
    InvalidDeviationConfig = 7013,
}
