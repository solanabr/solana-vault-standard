//! Claim redeem instruction stub.

use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ClaimRedeem<'info> {
    pub signer: Signer<'info>,
}

pub fn handler(_ctx: Context<ClaimRedeem>) -> Result<()> {
    Ok(())
}
