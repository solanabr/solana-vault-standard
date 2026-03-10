//! Module hook error codes.

use anchor_lang::prelude::*;

#[error_code]
pub enum ModuleError {
    #[msg("User is not on the whitelist")]
    NotWhitelisted,

    #[msg("User is on the blacklist")]
    Blacklisted,

    #[msg("User's account is frozen")]
    AccountFrozen,

    #[msg("Invalid merkle proof")]
    InvalidProof,

    #[msg("Deposit would exceed global vault cap")]
    GlobalCapExceeded,

    #[msg("Deposit would exceed per-user cap")]
    UserCapExceeded,

    #[msg("Shares are still locked")]
    SharesLocked,

    #[msg("Arithmetic overflow")]
    MathOverflow,
}
