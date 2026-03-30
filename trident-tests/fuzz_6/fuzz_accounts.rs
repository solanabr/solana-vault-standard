use trident_fuzz::fuzzing::*;

#[derive(Default)]
pub struct AccountAddresses {
    pub vault: AddressStorage,
    pub tranche_0: AddressStorage,
    pub tranche_1: AddressStorage,
    pub shares_mint_0: AddressStorage,
    pub shares_mint_1: AddressStorage,
    pub asset_mint: AddressStorage,
    pub asset_vault: AddressStorage,
    pub authority: AddressStorage,
    pub manager: AddressStorage,
    pub system_program: AddressStorage,
    pub token_2022_program: AddressStorage,
    pub asset_token_program: AddressStorage,
    pub rent: AddressStorage,
    pub user_share_accounts_0: [AddressStorage; 5],
    pub user_share_accounts_1: [AddressStorage; 5],
    pub user_asset_accounts: [AddressStorage; 5],
}
