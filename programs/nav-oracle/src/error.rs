use anchor_lang::prelude::*;

#[error_code]
pub enum NavOracleError {
    #[msg("Sequence must increment monotonically")]
    StaleSequence = 7000,

    #[msg("Signature does not match publisher key over canonical payload")]
    InvalidSignature = 7001,

    #[msg("Self-consistency check failed: nav_net != nav_gross × (1 − ter − loss)")]
    InconsistentNav = 7002,

    #[msg("Publisher rotation requires the configured key_rotation_authority signer")]
    UnauthorizedRotation = 7003,

    #[msg("Caller is not the registered publisher for this NavAccount")]
    UnauthorizedPublisher = 7004,

    #[msg("Timestamp must not be in the future")]
    TimestampInFuture = 7005,
}
