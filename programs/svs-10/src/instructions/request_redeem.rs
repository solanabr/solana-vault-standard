//! Request redeem instruction stub.

use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RequestRedeem<'info> {
    pub signer: Signer<'info>,
}

pub fn handler(_ctx: Context<RequestRedeem>, _shares: u64) -> Result<()> {
    Ok(())
}
