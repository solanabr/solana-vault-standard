use trident_fuzz::fuzzing::*;

#[derive(Default)]
pub struct AccountAddresses {
    pub vault: AddressStorage,
    pub shares_mint: AddressStorage,
    pub asset_mint: AddressStorage,
    pub deposit_vault: AddressStorage,
    pub redemption_escrow: AddressStorage,
    pub nav_oracle: AddressStorage,
    pub authority: AddressStorage,
    pub manager: AddressStorage,
    pub system_program: AddressStorage,
    pub token_2022_program: AddressStorage,
    pub asset_token_program: AddressStorage,
    pub associated_token_program: AddressStorage,
    pub rent: AddressStorage,
}
