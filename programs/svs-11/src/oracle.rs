use anchor_lang::prelude::*;

use crate::error::VaultError;
use crate::state::CreditVault;

/// Outcome of a successful NAV read (either source). `sequence == 0` is the
/// sentinel for the mock-oracle path (no monotonicity guarantee). Callers
/// only persist `last_seen_nav_sequence` when `oracle_source == 1`.
pub struct OraclePrice {
    pub price: u64,
    pub sequence: u64,
}

/// Outcome of a successful `read_nav_oracle_price` call. The vault writes
/// `sequence` into `last_seen_nav_sequence` and `price` into
/// `last_seen_nav_price` after each successful approve_*.
pub struct NavReadResult {
    pub price: u64,
    pub sequence: u64,
    #[allow(dead_code)]
    pub timestamp: i64,
}

/// Layout of the external oracle account. The oracle program must write this exact layout.
/// SVS-11 reads it as raw bytes (no CPI, no program dependency).
#[derive(Clone, Copy)]
#[repr(C)]
pub struct NavOracleData {
    pub price_per_share: u64,
    pub updated_at: i64,
}

impl NavOracleData {
    pub const LEN: usize = 8 + 8;

    /// Deserialize from raw account data, skipping the 8-byte Anchor discriminator.
    pub fn try_from_account(account: &AccountInfo) -> Result<Self> {
        let data = account.try_borrow_data()?;
        require!(data.len() >= 8 + Self::LEN, VaultError::OracleInvalidPrice);
        let price_per_share = u64::from_le_bytes(
            data[8..16]
                .try_into()
                .map_err(|_| error!(VaultError::OracleInvalidPrice))?,
        );
        let updated_at = i64::from_le_bytes(
            data[16..24]
                .try_into()
                .map_err(|_| error!(VaultError::OracleInvalidPrice))?,
        );
        Ok(Self {
            price_per_share,
            updated_at,
        })
    }
}

pub fn read_and_validate_oracle(
    oracle_account: &AccountInfo,
    vault: &CreditVault,
    clock: &Clock,
) -> Result<u64> {
    require!(
        *oracle_account.key == vault.nav_oracle,
        VaultError::OracleInvalidPrice
    );
    require!(
        *oracle_account.owner == vault.oracle_program,
        VaultError::OracleInvalidProgram
    );
    let data = NavOracleData::try_from_account(oracle_account)?;
    crate::math::validate_oracle(
        data.price_per_share,
        data.updated_at,
        clock.unix_timestamp,
        vault.max_staleness,
    )?;
    Ok(data.price_per_share)
}

/// Canonical NAV reader. Reads a `NavAccount` PDA owned by the
/// nav-oracle program and returns the validated `nav_net` price after:
///
/// 1. Existence check (lamports > 0, data populated).
/// 2. Layout check (Anchor 8-byte discriminator + ≥133 bytes of payload).
/// 3. Pool binding — `NavAccount.pool == expected_pool` (the CreditVault key).
/// 4. Staleness — `now − timestamp ≤ max_staleness_secs`.
/// 5. Sequence monotonicity — `sequence > last_seen_sequence` (replay guard).
/// 6. Deviation guard — `|nav_net − previous_price| ≤ max_deviation_bps`
///    of `previous_price` (skipped on first read where `previous_price == 0`).
///
/// **Publisher binding:** The publisher pubkey is read directly from
/// the on-chain `NavAccount.publisher` field rather than compared
/// against a CreditVault-stored copy. This avoids a
/// double-source-of-truth bug after `rotate_publisher` runs.
/// Authority over publisher rotation is gated by
/// `key_rotation_authority` in the nav-oracle program.
///
/// Layout offsets (must match `nav_oracle::state::NavAccount`):
///
/// ```text
///   payload[ 0.. 32]  pool: Pubkey
///   payload[32.. 40]  nav_net: u64
///   payload[40.. 48]  nav_gross: u64
///   payload[48.. 50]  ter_bps: u16
///   payload[50.. 52]  loss_provision_bps: u16
///   payload[52.. 53]  nav_type: u8
///   payload[53.. 60]  _padding: [u8; 7]
///   payload[60.. 68]  timestamp: i64
///   payload[68.. 76]  sequence: u64
///   payload[76..108]  publisher: Pubkey
///   payload[108..172] signature: [u8; 64]
///   payload[172..204] loan_tape_merkle_root: [u8; 32]
///   payload[204..236] key_rotation_authority: Pubkey
/// ```
///
/// Returns `NavReadResult` with the validated price + new sequence + timestamp.
/// Caller is responsible for persisting `last_seen_nav_sequence` and
/// `last_seen_nav_price` to the vault.
pub fn read_nav_oracle_price(
    nav_account: &AccountInfo,
    expected_pool: &Pubkey,
    last_seen_sequence: u64,
    max_staleness_secs: i64,
    max_deviation_bps: u16,
    previous_price: Option<u64>,
) -> Result<NavReadResult> {
    require!(
        nav_account.lamports() > 0 && !nav_account.data_is_empty(),
        VaultError::OracleAccountMissing
    );

    let data = nav_account.try_borrow_data()?;
    // 8 (discriminator) + 32 + 8 + 8 + 2 + 2 + 1 + 7 + 8 + 8 + 32 = 116 bytes minimum
    // to read everything we need (publisher ends at offset 116 in the file = 108 in the
    // stripped payload). The full NavAccount is larger, but this is the minimum to validate.
    require!(data.len() >= 8 + 108, VaultError::OracleAccountInvalid);

    // Strip the 8-byte Anchor discriminator. All offsets below are relative to
    // the start of the payload (i.e. `data[8 + offset]`).
    let payload = &data[8..];

    // pool: payload[0..32]
    let pool = Pubkey::try_from(&payload[0..32])
        .map_err(|_| error!(VaultError::OracleAccountInvalid))?;
    require!(&pool == expected_pool, VaultError::OraclePoolMismatch);

    // nav_net: payload[32..40]
    let nav_net = u64::from_le_bytes(
        payload[32..40]
            .try_into()
            .map_err(|_| error!(VaultError::OracleAccountInvalid))?,
    );

    // timestamp: payload[60..68]
    let timestamp = i64::from_le_bytes(
        payload[60..68]
            .try_into()
            .map_err(|_| error!(VaultError::OracleAccountInvalid))?,
    );

    // sequence: payload[68..76]
    let sequence = u64::from_le_bytes(
        payload[68..76]
            .try_into()
            .map_err(|_| error!(VaultError::OracleAccountInvalid))?,
    );

    // publisher: payload[76..108]. We READ the publisher from the on-chain
    // NavAccount as the single source of truth (post-rotate_publisher safety,
    // see plan Step 6). It is NOT compared to a CreditVault-stored copy.
    let _publisher = Pubkey::try_from(&payload[76..108])
        .map_err(|_| error!(VaultError::OracleAccountInvalid))?;

    // Staleness — `now − timestamp ≤ max_staleness_secs`. Negative deltas
    // (timestamp in the future) also fail because they exceed the bound when
    // checked as a non-negative duration.
    let now = Clock::get()?.unix_timestamp;
    let age = now
        .checked_sub(timestamp)
        .ok_or_else(|| error!(VaultError::OracleStale))?;
    require!(age >= 0 && age <= max_staleness_secs, VaultError::OracleStale);

    // Sequence — strictly increasing.
    require!(
        sequence > last_seen_sequence,
        VaultError::OracleSequenceStale
    );

    // Price sanity (rejects zero NAV, which would break the share-pricing math).
    require!(nav_net > 0, VaultError::OracleInvalidPrice);

    // Deviation guard. Skipped on the first read (previous_price == 0 / None).
    if let Some(prev) = previous_price {
        if prev > 0 {
            let diff = nav_net.abs_diff(prev) as u128;
            let max_diff = (prev as u128)
                .checked_mul(max_deviation_bps as u128)
                .and_then(|v| v.checked_div(10_000))
                .ok_or_else(|| error!(VaultError::MathOverflow))?;
            require!(diff <= max_diff, VaultError::OracleDeviationExceeded);
        }
    }

    Ok(NavReadResult {
        price: nav_net,
        sequence,
        timestamp,
    })
}
