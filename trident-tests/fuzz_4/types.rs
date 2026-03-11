#![allow(dead_code)]

use svs_oracle::PRICE_SCALE;

pub const NUM_USERS: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestStatus {
    None,
    Pending,
    Fulfilled,
    Claimed,
    Cancelled,
}

impl Default for RequestStatus {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Clone, Copy, Default)]
pub struct DepositRequestState {
    pub status: RequestStatus,
    pub assets_locked: u64,
    pub shares_claimable: u64,
    pub requested_at: i64,
    pub fulfilled_at: i64,
    pub cancel_not_before: i64,
}

#[derive(Clone, Copy, Default)]
pub struct RedeemRequestState {
    pub status: RequestStatus,
    pub shares_locked: u64,
    pub assets_claimable: u64,
    pub requested_at: i64,
    pub fulfilled_at: i64,
    pub cancel_not_before: i64,
}

#[derive(Clone, Copy, Default)]
pub struct UserState {
    pub shares_balance: u64,
    pub asset_balance: u64,
    pub deposit_request: DepositRequestState,
    pub redeem_request: RedeemRequestState,
    pub cumulative_deposited: u128,
    pub cumulative_redeemed: u128,
    /// Tracks previous deposit request status for monotonicity checking
    pub previous_deposit_status: RequestStatus,
    /// Tracks previous redeem request status for monotonicity checking
    pub previous_redeem_status: RequestStatus,
}

#[derive(Clone, Copy)]
pub struct OracleState {
    pub enabled: bool,
    pub price: u64,
    pub updated_at: i64,
    pub max_staleness: i64,
}

impl Default for OracleState {
    fn default() -> Self {
        Self {
            enabled: false,
            price: PRICE_SCALE,
            updated_at: 0,
            max_staleness: 3600,
        }
    }
}
