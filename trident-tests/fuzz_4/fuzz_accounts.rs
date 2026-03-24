use trident_fuzz::fuzzing::*;

/// Account addresses for SVS-7 native SOL vault fuzz testing.
#[derive(Default)]
pub struct AccountAddresses {
    pub vault: AddressStorage,

    pub shares_mint: AddressStorage,

    pub wsol_vault: AddressStorage,

    pub user: AddressStorage,

    pub native_mint: AddressStorage,

    pub user_wsol_account: AddressStorage,

    pub user_shares_account: AddressStorage,

    pub token_program: AddressStorage,

    pub token_2022_program: AddressStorage,

    pub associated_token_program: AddressStorage,

    pub system_program: AddressStorage,

    pub authority: AddressStorage,
}
