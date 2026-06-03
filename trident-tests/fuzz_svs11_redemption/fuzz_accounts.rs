use trident_fuzz::fuzzing::*;

#[derive(Default)]
pub struct AccountAddresses {
    pub vault: Option<Pubkey>,
    pub manager: Option<Pubkey>,
    pub investor: Option<Pubkey>,
}
