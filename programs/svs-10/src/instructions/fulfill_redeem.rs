//! Fulfill redeem instruction stub.

use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct FulfillRedeem<'info> {
    pub signer: Signer<'info>,
}

pub fn handler(_ctx: Context<FulfillRedeem>) -> Result<()> {
    Ok(())
}
