use trident_fuzz::fuzzing::*;

#[derive(Default)]
pub struct AccountAddresses {
    pub vault: Option<Pubkey>,
    pub shares_mint: Option<Pubkey>,
    pub authority: Option<Pubkey>,
}
