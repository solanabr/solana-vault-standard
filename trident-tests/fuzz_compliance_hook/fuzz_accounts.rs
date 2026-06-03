use trident_fuzz::fuzzing::*;

#[derive(Default)]
pub struct AccountAddresses {
    pub sanctions_list: Option<Pubkey>,
    pub mint_config: Option<Pubkey>,
    pub authority: Option<Pubkey>,
}
