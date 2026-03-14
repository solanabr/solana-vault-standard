//! SVS-8 Math helpers — wraps svs-math with Anchor error conversion.
//!
//! Additionally provides multi-asset–specific helpers:
//!   - `compute_portfolio_value` — reads (AssetEntry, asset_vault, oracle) triples
//!     from `remaining_accounts` and sums asset values in base units.
//!   - `normalize_oracle_price`  — converts (price, expo) → base-unit price per token.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;
use crate::errors::VaultError;
use crate::oracle::{validate_oracle_price, normalize_oracle_price};
use crate::state::AssetEntry;

// Re-export the Rounding type so callers only need to import this module.
pub use svs_math::Rounding;

// ── Share / asset conversion ──────────────────────────────────────────────────

/// Convert a base-unit deposit value to shares.
///
/// Uses a virtual offset (`10^decimals_offset`) to protect against share-price
/// inflation attacks (same pattern as SVS-1).
pub fn convert_to_shares(
      deposit_value: u64,
      total_shares: u64,
      total_portfolio_value: u64,
      offset: u64,
      rounding: Rounding,
  ) -> Result<u64> {
      // shares = deposit_value * (total_shares + offset) / (total_portfolio_value + 1)
    svs_math::mul_div(
              deposit_value,
              total_shares.checked_add(offset).ok_or(VaultError::MathOverflow)?,
              total_portfolio_value.checked_add(1).ok_or(VaultError::MathOverflow)?,
              rounding,
          )
      .map_err(|e| match e {
                svs_math::MathError::Overflow => VaultError::MathOverflow.into(),
                svs_math::MathError::DivisionByZero => VaultError::DivisionByZero.into(),
      })
}

/// Convert shares back to a base-unit asset value.
pub fn convert_to_assets(
      shares: u64,
      total_shares: u64,
      total_portfolio_value: u64,
      offset: u64,
      rounding: Rounding,
  ) -> Result<u64> {
      // assets = shares * (total_portfolio_value + 1) / (total_shares + offset)
    svs_math::mul_div(
              shares,
              total_portfolio_value.checked_add(1).ok_or(VaultError::MathOverflow)?,
              total_shares.checked_add(offset).ok_or(VaultError::MathOverflow)?,
              rounding,
          )
      .map_err(|e| match e {
                svs_math::MathError::Overflow => VaultError::MathOverflow.into(),
                svs_math::MathError::DivisionByZero => VaultError::DivisionByZero.into(),
      })
}

/// Safe multiply-then-divide with configurable rounding.
pub fn mul_div(value: u64, numerator: u64, denominator: u64, rounding: Rounding) -> Result<u64> {
      svs_math::mul_div(value, numerator, denominator, rounding).map_err(|e| match e {
                svs_math::MathError::Overflow => VaultError::MathOverflow.into(),
                svs_math::MathError::DivisionByZero => VaultError::DivisionByZero.into(),
      })
}

// ── Portfolio value ───────────────────────────────────────────────────────────

/// Compute the total portfolio value in base units by reading
/// `[AssetEntry, asset_vault, oracle] × N` from `remaining_accounts`.
///
/// Each group of 3 accounts represents one basket asset:
///   0 — `AssetEntry` PDA
///   1 — PDA-owned `TokenAccount` (asset vault)
///   2 — Oracle price feed (`UncheckedAccount`)
pub fn compute_portfolio_value(
      remaining_accounts: &[AccountInfo],
      max_staleness: u64,
  ) -> Result<u64> {
      require!(remaining_accounts.len() % 3 == 0, VaultError::AssetNotFound);

    let mut total: u128 = 0;

    for chunk in remaining_accounts.chunks_exact(3) {
              let entry_info  = &chunk[0];
              let vault_info  = &chunk[1];
              let oracle_info = &chunk[2];

          let entry: Account<AssetEntry> = Account::try_from(entry_info)?;
              let asset_vault: InterfaceAccount<TokenAccount> =
                            InterfaceAccount::try_from(vault_info)?;

          let price_data = validate_oracle_price(
                        oracle_info.clone(),
                        max_staleness,
                        crate::state::MAX_ORACLE_CONFIDENCE_BPS,
                    )?;

          let price_base = normalize_oracle_price(
                        price_data.price,
                        price_data.expo,
                        entry.asset_decimals,
                    )?;

          // value = amount * price_base / 10^asset_decimals
          let value = entry
                        .compute_value(asset_vault.amount, price_base)
                        .ok_or(VaultError::MathOverflow)?;

          total = total
                  .checked_add(value as u128)
                  .ok_or(VaultError::MathOverflow)?;
    }

    u64::try_from(total).map_err(|_| VaultError::MathOverflow.into())
}
