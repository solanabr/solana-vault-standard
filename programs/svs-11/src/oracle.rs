use anchor_lang::prelude::*;

use crate::error::VaultError;
use crate::state::CreditVault;

pub struct OraclePrice {
    pub price: u64,
    pub sequence: u64,
}

pub struct NavReadResult {
    pub price: u64,
    pub sequence: u64,
    #[allow(dead_code)]
    pub timestamp: i64,
}

/// External oracle account layout (mock oracle path). The oracle program
/// must write this exact layout; SVS-11 reads it as raw bytes.
#[derive(Clone, Copy)]
#[repr(C)]
pub struct NavOracleData {
    pub price_per_share: u64,
    pub updated_at: i64,
}

impl NavOracleData {
    pub const LEN: usize = 8 + 8;

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

/// Read + validate a `NavAccount` PDA owned by the nav-oracle program.
///
/// Publisher is read from `NavAccount.publisher` (single source of truth
/// post-rotate); not compared against any CreditVault-stored copy.
///
/// Layout offsets (must match `nav_oracle::state::NavAccount`, after the
/// 8-byte Anchor discriminator):
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
    require!(data.len() >= 8 + 108, VaultError::OracleAccountInvalid);
    let payload = &data[8..];

    let pool =
        Pubkey::try_from(&payload[0..32]).map_err(|_| error!(VaultError::OracleAccountInvalid))?;
    require!(&pool == expected_pool, VaultError::OraclePoolMismatch);

    let nav_net = u64::from_le_bytes(
        payload[32..40]
            .try_into()
            .map_err(|_| error!(VaultError::OracleAccountInvalid))?,
    );

    let timestamp = i64::from_le_bytes(
        payload[60..68]
            .try_into()
            .map_err(|_| error!(VaultError::OracleAccountInvalid))?,
    );

    let sequence = u64::from_le_bytes(
        payload[68..76]
            .try_into()
            .map_err(|_| error!(VaultError::OracleAccountInvalid))?,
    );

    let _publisher = Pubkey::try_from(&payload[76..108])
        .map_err(|_| error!(VaultError::OracleAccountInvalid))?;

    let now = Clock::get()?.unix_timestamp;
    let age = now
        .checked_sub(timestamp)
        .ok_or_else(|| error!(VaultError::OracleStale))?;
    require!(
        age >= 0 && age <= max_staleness_secs,
        VaultError::OracleStale
    );

    require!(
        sequence > last_seen_sequence,
        VaultError::OracleSequenceStale
    );

    require!(nav_net > 0, VaultError::OracleInvalidPrice);

    if let Some(prev) = previous_price {
        if prev > 0 {
            let diff = u128::from(nav_net.abs_diff(prev));
            let max_diff = u128::from(prev)
                .checked_mul(u128::from(max_deviation_bps))
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
