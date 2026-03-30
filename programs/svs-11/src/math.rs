use anchor_lang::prelude::*;

use crate::error::VaultError;

pub fn assets_to_shares(assets: u64, price_per_share: u64) -> Result<u64> {
    svs_oracle::assets_to_shares(assets, price_per_share).map_err(|e| match e {
        svs_oracle::OracleError::InvalidPrice => VaultError::OracleInvalidPrice.into(),
        svs_oracle::OracleError::MathOverflow => VaultError::MathOverflow.into(),
        svs_oracle::OracleError::StalePrice => VaultError::OracleStale.into(),
        svs_oracle::OracleError::UnauthorizedUpdate => VaultError::Unauthorized.into(),
        svs_oracle::OracleError::PriceDeviationExceeded => VaultError::OracleInvalidPrice.into(),
    })
}

pub fn shares_to_assets(shares: u64, price_per_share: u64) -> Result<u64> {
    svs_oracle::shares_to_assets(shares, price_per_share).map_err(|e| match e {
        svs_oracle::OracleError::InvalidPrice => VaultError::OracleInvalidPrice.into(),
        svs_oracle::OracleError::MathOverflow => VaultError::MathOverflow.into(),
        svs_oracle::OracleError::StalePrice => VaultError::OracleStale.into(),
        svs_oracle::OracleError::UnauthorizedUpdate => VaultError::Unauthorized.into(),
        svs_oracle::OracleError::PriceDeviationExceeded => VaultError::OracleInvalidPrice.into(),
    })
}

pub fn validate_oracle(
    price: u64,
    updated_at: i64,
    current_timestamp: i64,
    max_staleness: i64,
) -> Result<()> {
    svs_oracle::validate_price(price).map_err(|_| VaultError::OracleInvalidPrice)?;
    svs_oracle::validate_freshness(updated_at, current_timestamp, max_staleness)
        .map_err(|_| VaultError::OracleStale)?;
    Ok(())
}
