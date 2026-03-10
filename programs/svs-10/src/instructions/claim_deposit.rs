//! Claim deposit instruction stub.

use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ClaimDeposit<'info> {
    pub signer: Signer<'info>,
}

pub fn handler(_ctx: Context<ClaimDeposit>) -> Result<()> {
    Ok(())
}
