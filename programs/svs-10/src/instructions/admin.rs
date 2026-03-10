//! Admin instructions stub: pause, unpause, transfer authority, set vault operator.

use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct Admin<'info> {
    pub signer: Signer<'info>,
}

pub fn pause(_ctx: Context<Admin>) -> Result<()> {
    Ok(())
}

pub fn unpause(_ctx: Context<Admin>) -> Result<()> {
    Ok(())
}

pub fn transfer_authority(_ctx: Context<Admin>, _new_authority: Pubkey) -> Result<()> {
    Ok(())
}

pub fn set_vault_operator(_ctx: Context<Admin>, _new_operator: Pubkey) -> Result<()> {
    Ok(())
}
