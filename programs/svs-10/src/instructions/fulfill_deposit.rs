//! Fulfill deposit instruction stub.

use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct FulfillDeposit<'info> {
    pub signer: Signer<'info>,
}

pub fn handler(_ctx: Context<FulfillDeposit>) -> Result<()> {
    Ok(())
}
