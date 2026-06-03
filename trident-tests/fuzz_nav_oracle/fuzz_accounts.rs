use trident_fuzz::fuzzing::*;

#[derive(Default)]
pub struct AccountAddresses {
    pub nav_account: Option<Pubkey>,
    pub publisher: Option<Pubkey>,
    pub key_rotation_authority: Option<Pubkey>,
}
