use trident_fuzz::fuzzing::*;

/// Account addresses for SVS-2 fuzz testing.
#[derive(Default)]
pub struct AccountAddresses {
    pub vault: AddressStorage,
    pub shares_mint: AddressStorage,
    pub user: AddressStorage,
    pub asset_mint: AddressStorage,
    pub user_asset_account: AddressStorage,
    pub asset_vault: AddressStorage,
    pub user_shares_account: AddressStorage,
    pub asset_token_program: AddressStorage,
    pub token_2022_program: AddressStorage,
    pub associated_token_program: AddressStorage,
    pub system_program: AddressStorage,
    pub authority: AddressStorage,
    pub rent: AddressStorage,
    pub owner_shares_account: AddressStorage,
}
