use trident_fuzz::fuzzing::*;

#[derive(Default)]
pub struct AccountAddresses {
    pub vault: AddressStorage,
    pub shares_mint: AddressStorage,
    pub asset_mint: AddressStorage,
    pub asset_vault: AddressStorage,
    pub share_escrow: AddressStorage,
    pub user: AddressStorage,
    pub operator: AddressStorage,
    pub deposit_request: AddressStorage,
    pub redeem_request: AddressStorage,
    pub claimable_escrow: AddressStorage,
    pub claimable_tokens: AddressStorage,
    pub oracle_price: AddressStorage,
    pub authority: AddressStorage,
    pub user_asset_account: AddressStorage,
    pub user_shares_account: AddressStorage,
    pub receiver_asset_account: AddressStorage,
    pub receiver_shares_account: AddressStorage,
}
