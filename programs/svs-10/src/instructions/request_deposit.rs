//! Request deposit instruction stub.

use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RequestDeposit<'info> {
    pub signer: Signer<'info>,
}

pub fn handler(_ctx: Context<RequestDeposit>, _assets: u64) -> Result<()> {
    Ok(())
}
