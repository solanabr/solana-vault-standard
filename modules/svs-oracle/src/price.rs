//! Canonical SVS oracle price interface.
//!
//! Any SVS-compliant oracle writes a 25-byte `SvsOraclePrice` header at the
//! START of its account payload (immediately after the 8-byte Anchor
//! discriminator). Implementation-specific data lives AFTER byte 25 and the
//! consuming vault never reads it.
//!
//! The leading `version` byte lets `read_oracle` detect layout drift at
//! runtime: any future field reorder (or a third-party oracle writing an
//! incompatible header) bumps the version, and readers fail closed with
//! `WrongVersion` rather than silently parsing garbage. Mirrors the
//! `svs-attestation` version-byte convention.
//!
//! On-disk layout (Anchor #[account]):
//!   0.. 8  discriminator
//!   8.. 9  version:   u8       (== SVS_ORACLE_VERSION)
//!   9..17  price:     u64 LE
//!  17..25  timestamp: i64 LE
//!  25..33  sequence:  u64 LE
//!  33..    implementation-specific

use crate::error::OracleError;

/// Offset of the price payload within an Anchor account's data.
pub const PRICE_PAYLOAD_OFFSET: usize = 8;
/// Canonical header layout version. Bump on any field reorder/resize.
pub const SVS_ORACLE_VERSION: u8 = 1;
/// Size of the canonical price header (version + price + timestamp + sequence).
pub const SVS_ORACLE_PRICE_LEN: usize = 25;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SvsOraclePrice {
    pub version: u8,
    pub price: u64,
    pub timestamp: i64,
    pub sequence: u64,
}

impl SvsOraclePrice {
    /// Serialize the canonical header (for oracles writing the layout).
    pub fn to_header_bytes(&self) -> [u8; SVS_ORACLE_PRICE_LEN] {
        let mut buf = [0u8; SVS_ORACLE_PRICE_LEN];
        buf[0] = self.version;
        buf[1..9].copy_from_slice(&self.price.to_le_bytes());
        buf[9..17].copy_from_slice(&self.timestamp.to_le_bytes());
        buf[17..25].copy_from_slice(&self.sequence.to_le_bytes());
        buf
    }

    /// Parse the header from raw account data (skips the 8-byte discriminator).
    /// Pure parser — `read_oracle` enforces the version match.
    pub fn from_account_data(data: &[u8]) -> Result<Self, OracleError> {
        let end = PRICE_PAYLOAD_OFFSET + SVS_ORACLE_PRICE_LEN;
        if data.len() < end {
            return Err(OracleError::AccountTooSmall);
        }
        let p = &data[PRICE_PAYLOAD_OFFSET..end];
        Ok(Self {
            version: p[0],
            price: u64::from_le_bytes(p[1..9].try_into().map_err(|_| OracleError::InvalidPrice)?),
            timestamp: i64::from_le_bytes(
                p[9..17].try_into().map_err(|_| OracleError::InvalidPrice)?,
            ),
            sequence: u64::from_le_bytes(
                p[17..25]
                    .try_into()
                    .map_err(|_| OracleError::InvalidPrice)?,
            ),
        })
    }
}

/// Generic SVS oracle read: parse the header and enforce the universal
/// invariants (positive price, staleness, sequence replay floor). Owner/
/// address binding is the caller's responsibility (it knows the configured
/// program + account). Returns the validated header.
///
/// The sequence is a replay FLOOR, not a per-read nonce: a publication is
/// rejected only when its sequence is STRICTLY older than the last seen
/// (`sequence < last_seen`). The *current* publication (`sequence == last_seen`)
/// is accepted on every read, so a vault can settle a whole queue of requests
/// against a single published NAV; only a strictly-older signed payload is a
/// replay and rejected.
///
/// `sequence == 0` is the "sequencing unused" sentinel: the floor check is
/// skipped and the caller must NOT advance its last-seen counter.
pub fn read_oracle(
    data: &[u8],
    now: i64,
    max_staleness: i64,
    last_seen_sequence: u64,
) -> Result<SvsOraclePrice, OracleError> {
    let header = SvsOraclePrice::from_account_data(data)?;

    if header.version != SVS_ORACLE_VERSION {
        return Err(OracleError::WrongVersion);
    }

    if header.price == 0 {
        return Err(OracleError::InvalidPrice);
    }

    let age = now
        .checked_sub(header.timestamp)
        .ok_or(OracleError::StalePrice)?;
    if age < 0 || age > max_staleness {
        return Err(OracleError::StalePrice);
    }

    if header.sequence != 0 && header.sequence < last_seen_sequence {
        return Err(OracleError::SequenceStale);
    }

    Ok(header)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account_with(price: u64, ts: i64, seq: u64) -> Vec<u8> {
        let mut v = vec![0u8; 8]; // discriminator
        v.extend_from_slice(
            &SvsOraclePrice {
                version: SVS_ORACLE_VERSION,
                price,
                timestamp: ts,
                sequence: seq,
            }
            .to_header_bytes(),
        );
        v
    }

    #[test]
    fn roundtrip_header() {
        let p = SvsOraclePrice {
            version: SVS_ORACLE_VERSION,
            price: 1_000_000_000,
            timestamp: 1700,
            sequence: 5,
        };
        let bytes = p.to_header_bytes();
        let mut acct = vec![0u8; 8];
        acct.extend_from_slice(&bytes);
        assert_eq!(SvsOraclePrice::from_account_data(&acct).unwrap(), p);
    }

    #[test]
    fn rejects_short_account() {
        assert_eq!(
            SvsOraclePrice::from_account_data(&[0u8; 20]),
            Err(OracleError::AccountTooSmall)
        );
    }

    #[test]
    fn rejects_wrong_version() {
        // A header whose leading version byte does not match is rejected
        // before any price/staleness logic runs (fail-closed on drift).
        let mut acct = account_with(1_000_000_000, 1700, 1);
        acct[PRICE_PAYLOAD_OFFSET] = SVS_ORACLE_VERSION.wrapping_add(1);
        assert_eq!(
            read_oracle(&acct, 1700, 3600, 0),
            Err(OracleError::WrongVersion)
        );
    }

    #[test]
    fn rejects_zero_price() {
        let acct = account_with(0, 1700, 1);
        assert_eq!(
            read_oracle(&acct, 1700, 3600, 0),
            Err(OracleError::InvalidPrice)
        );
    }

    #[test]
    fn rejects_stale() {
        let acct = account_with(1_000_000_000, 1000, 1);
        assert_eq!(
            read_oracle(&acct, 1000 + 3601, 3600, 0),
            Err(OracleError::StalePrice)
        );
    }

    #[test]
    fn rejects_future_timestamp() {
        let acct = account_with(1_000_000_000, 2000, 1);
        assert_eq!(
            read_oracle(&acct, 1000, 3600, 0),
            Err(OracleError::StalePrice)
        );
    }

    #[test]
    fn sequence_zero_skips_monotonicity() {
        let acct = account_with(1_000_000_000, 1700, 0);
        assert!(read_oracle(&acct, 1700, 3600, 999).is_ok());
    }

    #[test]
    fn accepts_equal_sequence_for_batch_settlement() {
        // The current publication (sequence == last_seen) is reusable, so a
        // vault can settle many queued requests against one published NAV.
        let acct = account_with(1_000_000_000, 1700, 5);
        assert!(read_oracle(&acct, 1700, 3600, 5).is_ok());
    }

    #[test]
    fn rejects_strictly_older_sequence() {
        // A strictly-older signed payload is a replay.
        let acct = account_with(1_000_000_000, 1700, 4);
        assert_eq!(
            read_oracle(&acct, 1700, 3600, 5),
            Err(OracleError::SequenceStale)
        );
    }

    #[test]
    fn accepts_advancing_sequence() {
        let acct = account_with(1_000_000_000, 1700, 6);
        assert!(read_oracle(&acct, 1700, 3600, 5).is_ok());
    }
}
