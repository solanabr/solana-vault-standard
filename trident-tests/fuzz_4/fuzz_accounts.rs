use trident_fuzz::fuzzing::*;

/// Account addresses for SVS-10 async vault fuzz testing.
#[derive(Default)]
#[allow(dead_code)]
pub struct AccountAddresses {
    pub vault: AddressStorage,
    pub shares_mint: AddressStorage,
    pub asset_mint: AddressStorage,
    pub asset_vault: AddressStorage,
    pub share_escrow: AddressStorage,
    pub deposit_request: AddressStorage,
    pub redeem_request: AddressStorage,
    pub claimable_escrow: AddressStorage,
}
