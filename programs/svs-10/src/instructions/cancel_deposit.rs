//! Cancel deposit instruction stub.

use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CancelDeposit<'info> {
    pub signer: Signer<'info>,
}

pub fn handler(_ctx: Context<CancelDeposit>) -> Result<()> {
    Ok(())
}
