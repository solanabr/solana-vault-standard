//! SVS-8 Multi-Asset Basket Vault — error codes.
use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
      // ── Generic ──────────────────────────────────────────────────────────────
    #[msg("Amount must be greater than zero")]
      ZeroAmount,

      #[msg("Slippage tolerance exceeded")]
      SlippageExceeded,

      #[msg("Vault is paused")]
      VaultPaused,

      #[msg("Arithmetic overflow")]
      MathOverflow,

      #[msg("Division by zero")]
      DivisionByZero,

      #[msg("Insufficient shares balance")]
      InsufficientShares,

      #[msg("Unauthorized — caller is not vault authority")]
      Unauthorized,

      #[msg("New authority must differ from current authority")]
      SameAuthority,

      // ── Multi-asset basket ────────────────────────────────────────────────────
      #[msg("Basket already contains the maximum number of assets (8)")]
      MaxAssetsExceeded,

      #[msg("Basket is empty — add at least one asset first")]
      BasketEmpty,

      #[msg("Asset not found in basket")]
      AssetNotFound,

      #[msg("Asset vault is not empty — drain it before removing the asset")]
      AssetVaultNotEmpty,

      #[msg("Target weight must be > 0 and the sum must not exceed 10 000 bps")]
      InvalidWeight,

      #[msg("Weights must sum to exactly 10 000 bps (100 %)")]
      WeightsMustSumToTenThousand,

      #[msg("Number of weights provided does not match number of basket assets")]
      WeightCountMismatch,

      // ── Oracle ────────────────────────────────────────────────────────────────
      #[msg("Oracle account could not be parsed as a recognised price feed")]
      InvalidOracle,

      #[msg("Oracle price is stale — publish time exceeds MAX_ORACLE_STALENESS")]
      OracleStale,

      #[msg("Oracle confidence interval is too wide — exceeds MAX_ORACLE_CONFIDENCE_BPS")]
      OracleUncertain,

      #[msg("Oracle price is negative or zero")]
      OracleInvalidPrice,

      // ── CPI / program ─────────────────────────────────────────────────────────
      #[msg("Invalid external program ID (expected Jupiter aggregator)")]
      InvalidProgram,

      // ── Module errors (available with `modules` feature) ─────────────────────
      #[msg("Deposit would exceed global vault cap")]
      GlobalCapExceeded,

      #[msg("Entry fee exceeds maximum allowed value")]
      EntryFeeExceedsMax,

      #[msg("Lock duration exceeds maximum allowed value")]
      LockDurationExceedsMax,
}
