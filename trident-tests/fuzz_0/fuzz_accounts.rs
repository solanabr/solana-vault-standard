use trident_fuzz::fuzzing::*;

/// Storage for all account addresses used in fuzz testing.
///
/// This struct serves as a centralized repository for account addresses,
/// enabling their reuse across different instruction flows and test scenarios.
///
/// Docs: https://ackee.xyz/trident/docs/latest/trident-api-macro/trident-types/fuzz-accounts/
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
