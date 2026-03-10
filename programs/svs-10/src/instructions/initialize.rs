//! Initialize instruction stub.

use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct Initialize<'info> {
    pub signer: Signer<'info>,
}

pub fn handler(
    _ctx: Context<Initialize>,
    _vault_id: u64,
    _name: String,
    _symbol: String,
    _uri: String,
) -> Result<()> {
    Ok(())
}
