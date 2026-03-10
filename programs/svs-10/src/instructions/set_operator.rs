//! Set operator approval instruction stub.

use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetOperator<'info> {
    pub signer: Signer<'info>,
}

pub fn handler(_ctx: Context<SetOperator>, _operator: Pubkey, _approved: bool) -> Result<()> {
    Ok(())
}
