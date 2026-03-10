//! View instructions stub: read-only queries for async vault state.

use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct VaultView<'info> {
    pub signer: Signer<'info>,
}

pub fn pending_deposit_request(_ctx: Context<VaultView>) -> Result<()> {
    Ok(())
}

pub fn claimable_deposit_request(_ctx: Context<VaultView>) -> Result<()> {
    Ok(())
}

pub fn pending_redeem_request(_ctx: Context<VaultView>) -> Result<()> {
    Ok(())
}

pub fn claimable_redeem_request(_ctx: Context<VaultView>) -> Result<()> {
    Ok(())
}
