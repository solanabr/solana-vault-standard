//! Cancel redeem instruction stub.

use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CancelRedeem<'info> {
    pub signer: Signer<'info>,
}

pub fn handler(_ctx: Context<CancelRedeem>) -> Result<()> {
    Ok(())
}
