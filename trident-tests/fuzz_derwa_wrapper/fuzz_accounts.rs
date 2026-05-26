use trident_fuzz::fuzzing::*;

#[derive(Default)]
pub struct AccountAddresses {
    pub wrapper_config: Option<Pubkey>,
    pub wrapper_signer: Option<Pubkey>,
    pub permissioned_mint: Option<Pubkey>,
    pub derwa_mint: Option<Pubkey>,
    pub investor: Option<Pubkey>,
}
