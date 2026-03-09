use trident_fuzz::fuzzing::*;

/// Account addresses for CT state machine fuzz testing.
#[derive(Default)]
pub struct AccountAddresses {
    pub vault: AddressStorage,
    pub shares_mint: AddressStorage,
    pub user: AddressStorage,
    pub asset_mint: AddressStorage,
}
