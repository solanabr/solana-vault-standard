//! SVS-8 Oracle module.
//!
//! Provides a unified oracle interface that supports:
//!   - **Pyth Network** (`PriceUpdateV2` account from `pyth-solana-receiver-sdk`)
//!   - **svs-oracle** internal oracle (mock / custom prices, used in tests and local vaults)
//!
//! Every `AssetEntry` in the basket holds a reference to its oracle account.
//! All financial operations (deposit, redeem, rebalance) **must** pass all oracle
//! accounts so the vault can compute a fresh, confident total portfolio value.
//!
//! Staleness and confidence-interval limits are defined in `state.rs` as
//! `MAX_ORACLE_STALENESS` and `MAX_ORACLE_CONFIDENCE_BPS`.
use anchor_lang::prelude::*;
use crate::errors::VaultError;

// ── Public types ──────────────────────────────────────────────────────────────

/// Normalised oracle price returned by `validate_oracle_price`.
#[derive(Clone, Copy, Debug)]
pub struct OraclePrice {
      /// Raw price mantissa (may be negative — reject at call site if ≤ 0).
    pub price: i64,
      /// Exponent: effective price = price * 10^expo.
      pub expo: i32,
      /// 1-sigma confidence interval in the same units as `price`.
      pub confidence: u64,
      /// Unix timestamp of the last update (seconds).
      pub updated_at: i64,
}

// ── Pyth discriminator ────────────────────────────────────────────────────────
// The first 8 bytes of a `PriceUpdateV2` account data are the Anchor discriminator.
// We detect this at runtime to distinguish Pyth feeds from svs-oracle accounts.
const PYTH_DISCRIMINATOR: [u8; 8] = [0x9e, 0x5d, 0x3c, 0x30, 0x2d, 0xad, 0xd4, 0x86];

// ── Public API ────────────────────────────────────────────────────────────────

/// Validate that the oracle account contains a fresh, confident price.
///
/// Returns an [`OraclePrice`] on success, or one of:
///   - `VaultError::InvalidOracle`   — account cannot be parsed
///   - `VaultError::OracleStale`     — price is older than `max_staleness_secs`
///   - `VaultError::OracleUncertain` — confidence interval too wide
///   - `VaultError::OracleInvalidPrice` — price is ≤ 0
pub fn validate_oracle_price(
      oracle: AccountInfo,
      max_staleness_secs: u64,
      max_confidence_bps: u64,
  ) -> Result<OraclePrice> {
      let data = oracle.try_borrow_data().map_err(|_| VaultError::InvalidOracle)?;
      if data.len() < 8 {
                return err!(VaultError::InvalidOracle);
      }

    let mut discriminator = [0u8; 8];
      discriminator.copy_from_slice(&data[..8]);

    if discriminator == PYTH_DISCRIMINATOR {
              parse_pyth(&data, max_staleness_secs, max_confidence_bps)
    } else {
              parse_svs_oracle(&data, max_staleness_secs)
    }
}

/// Convert a raw `(price, expo)` pair to **base-unit price per token**.
///
/// `base_decimals` is the decimal precision of the vault's base unit (e.g. 6 for USD).
/// `asset_decimals` is the decimal precision of the asset token mint.
///
/// The result is:  `price_per_token_in_base_units`
///   = `price * 10^base_decimals / 10^asset_decimals * 10^expo`   (simplified)
///
/// Concretely, if BTC has 8 decimals, the oracle price is 50000.0000 USD, and
/// base_decimals = 6 (USDC), then for 1 BTC (= 10^8 raw units):
///   value = 10^8 * price_base / 10^8 = price_base
pub fn normalize_oracle_price(price: i64, expo: i32, asset_decimals: u8) -> Result<u64> {
      require!(price > 0, VaultError::OracleInvalidPrice);
      let price_u: u128 = price as u128;

    // We work in base-unit (6 decimals) price per **one raw token unit**:
    //   price_base = price * 10^(6 + expo) / 10^asset_decimals
    // expo is typically negative (e.g. -8), so we handle both cases.

    let scale: i32 = 6_i32 + expo - (asset_decimals as i32);

    let result: u128 = if scale >= 0 {
              price_u
                  .checked_mul(10u128.pow(scale as u32))
                  .ok_or(VaultError::MathOverflow)?
    } else {
              let divisor = 10u128.pow((-scale) as u32);
              price_u
                  .checked_div(divisor)
                  .ok_or(VaultError::MathOverflow)?
    };

    u64::try_from(result).map_err(|_| VaultError::MathOverflow.into())
}

// ── Pyth parsing ──────────────────────────────────────────────────────────────

/// Parse a Pyth `PriceUpdateV2` account (discriminator already verified).
///
/// Memory layout (after 8-byte discriminator):
///   offset 0  : write_authority  [u8; 32]
///   offset 32 : verification_level u8
///   offset 33 : price_message    (PriceFeedMessage) — we extract relevant fields
///
/// PriceFeedMessage layout:
///   0  : feed_id    [u8; 32]
///   32 : price       i64
///   40 : conf        u64
///   48 : exponent    i32
///   52 : publish_time i64
///   60 : prev_publish_time i64
///   68 : ema_price   i64
///   76 : ema_conf    u64
fn parse_pyth(
      data: &[u8],
      max_staleness_secs: u64,
      max_confidence_bps: u64,
  ) -> Result<OraclePrice> {
      // skip discriminator (8) + write_authority (32) + verification_level (1) + feed_id (32)
    const MSG_BASE: usize = 8 + 32 + 1 + 32;

    if data.len() < MSG_BASE + 76 + 8 {
              return err!(VaultError::InvalidOracle);
    }

    let price = i64::from_le_bytes(
              data[MSG_BASE..MSG_BASE + 8].try_into().map_err(|_| VaultError::InvalidOracle)?,
          );
      let conf = u64::from_le_bytes(
                data[MSG_BASE + 8..MSG_BASE + 16].try_into().map_err(|_| VaultError::InvalidOracle)?,
            );
      let exponent = i32::from_le_bytes(
                data[MSG_BASE + 16..MSG_BASE + 20].try_into().map_err(|_| VaultError::InvalidOracle)?,
            );
      let publish_time = i64::from_le_bytes(
                data[MSG_BASE + 20..MSG_BASE + 28].try_into().map_err(|_| VaultError::InvalidOracle)?,
            );

    // Staleness check
    let clock = Clock::get()?;
      let age = (clock.unix_timestamp - publish_time).max(0) as u64;
      require!(age <= max_staleness_secs, VaultError::OracleStale);

    // Confidence check: conf <= price * max_confidence_bps / 10_000
    if price > 0 {
              let price_abs = price as u64;
              let max_conf = price_abs
                            .checked_mul(max_confidence_bps)
                            .and_then(|v| v.checked_div(10_000))
                            .ok_or(VaultError::MathOverflow)?;
              require!(conf <= max_conf, VaultError::OracleUncertain);
    }

    require!(price > 0, VaultError::OracleInvalidPrice);

    Ok(OraclePrice {
              price,
              expo: exponent,
              confidence: conf,
              updated_at: publish_time,
    })
}

// ── svs-oracle (internal) parsing ────────────────────────────────────────────

/// Parse an `OraclePrice` stored by the svs-oracle module.
///
/// Layout (after 8-byte discriminator):
///   0  : price      i64
///   8  : expo       i32
///   12 : updated_at i64
///   20 : confidence u64
fn parse_svs_oracle(data: &[u8], max_staleness_secs: u64) -> Result<OraclePrice> {
      const BASE: usize = 8; // skip discriminator
    if data.len() < BASE + 28 {
              return err!(VaultError::InvalidOracle);
    }

    let price = i64::from_le_bytes(
              data[BASE..BASE + 8].try_into().map_err(|_| VaultError::InvalidOracle)?,
          );
      let expo = i32::from_le_bytes(
                data[BASE + 8..BASE + 12].try_into().map_err(|_| VaultError::InvalidOracle)?,
            );
      let updated_at = i64::from_le_bytes(
                data[BASE + 12..BASE + 20].try_into().map_err(|_| VaultError::InvalidOracle)?,
            );
      let confidence = u64::from_le_bytes(
                data[BASE + 20..BASE + 28].try_into().map_err(|_| VaultError::InvalidOracle)?,
            );

    let clock = Clock::get()?;
      let age = (clock.unix_timestamp - updated_at).max(0) as u64;
      require!(age <= max_staleness_secs, VaultError::OracleStale);

    require!(price > 0, VaultError::OracleInvalidPrice);

    Ok(OraclePrice {
              price,
              expo,
              confidence,
              updated_at,
    })
}
